import express from "express";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { logger } from "./observability/logger.js";
import { recordHttpRequest, renderMetrics } from "./observability/metrics.js";
import { parseWebhookUrl } from "./security/webhook-url.js";
import { prisma } from "./db/prisma.js";
import { generateApiKey, hashApiKey } from "./security/api-key.js";
import { requireTenantApiKey } from "./middleware/require-tenant-api-key.js";
import { createTenantRateLimiter } from "./middleware/tenant-rate-limiter.js";
import { rateLimitRedis } from "./queue/rate-limit-redis.js";
import { encodePaginationCursor, parsePagination } from "./utils/pagination.js";
import { createModelProvider } from "./ai/model-provider.js";
import { getTenantOperationsSummary } from "./services/operations-summary.js";

const app = express();

app.disable("x-powered-by");

app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    "Cache-Control": "no-store",
  });

  return next();
});

app.use((req, res, next) => {
  const suppliedRequestId = req.get("x-request-id");
  const requestId =
    suppliedRequestId && /^[A-Za-z0-9._-]{1,128}$/.test(suppliedRequestId)
      ? suppliedRequestId
      : randomUUID();

  req.requestId = requestId;
  res.set("X-Request-Id", requestId);

  const startedAt = performance.now();

  res.on("finish", () => {
    const durationMs = performance.now() - startedAt;
    const route = req.route?.path ? `${req.baseUrl}${req.route.path}` : "unmatched";

    recordHttpRequest({
      method: req.method,
      route,
      statusCode: res.statusCode,
      durationMs,
    });

    logger.info("http_request_completed", {
      requestId,
      method: req.method,
      route,
      statusCode: res.statusCode,
      durationMs: Number(durationMs.toFixed(2)),
    });
  });

  return next();
});

app.use(express.json({ limit: "1mb" }));

function sendSuccess(res, statusCode, data) {
  return res.status(statusCode).json({ data });
}

function sendError(res, statusCode, code, message) {
  return res.status(statusCode).json({
    error: {
      code,
      message,
    },
  });
}

app.get("/ready", async (req, res) => {
  const checks = {
    database: "ok",
    redis: "ok",
  };

  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    checks.database = "error";
  }

  try {
    await rateLimitRedis.ping();
  } catch {
    checks.redis = "error";
  }

  const ready = Object.values(checks).every((status) => status === "ok");

  return res.status(ready ? 200 : 503).json({
    data: {
      status: ready ? "ready" : "not_ready",
      service: "relayforge",
      checks,
    },
  });
});

app.get("/metrics", (req, res) => {
  res.set("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
  return res.status(200).send(renderMetrics());
});

app.get("/health", (req, res) => {
  return sendSuccess(res, 200, {
    status: "ok",
    service: "relayforge",
  });
});

app.post("/tenants", async (req, res) => {
  const name = req.body?.name;

  if (typeof name !== "string" || name.trim().length === 0) {
    return sendError(res, 400, "VALIDATION_ERROR", "Tenant name is required");
  }

  const apiKey = generateApiKey();

  const tenant = await prisma.tenant.create({
    data: {
      name: name.trim(),
      apiKeyHash: hashApiKey(apiKey),
    },
  });

  return sendSuccess(res, 201, {
    id: tenant.id,
    name: tenant.name,
    apiKey,
    createdAt: tenant.createdAt,
  });
});

app.use("/tenants/:id", requireTenantApiKey);

const tenantRateLimiter = createTenantRateLimiter({
  getRedisClient: () => rateLimitRedis,
});

app.use("/tenants/:id", tenantRateLimiter);

app.get("/tenants/:id", async (req, res) => {
  const { id } = req.params;

  const tenant = await prisma.tenant.findUnique({
    where: { id },
    select: {
      id: true,
      name: true,
      createdAt: true,
    },
  });

  if (!tenant) {
    return sendError(res, 404, "TENANT_NOT_FOUND", "Tenant not found");
  }

  return sendSuccess(res, 200, {
    id: tenant.id,
    name: tenant.name,
    createdAt: tenant.createdAt,
  });
});

app.get("/tenants/:id/ai/operations-summary", async (req, res) => {
  const summary = await getTenantOperationsSummary(prisma, req.authTenantId, {
    generateNarrative: async (facts) => {
      const provider = createModelProvider();
      return provider.generate(
        `Summarize these RelayForge webhook operations facts in 3-5 concise sentences. Report the numbers exactly. Describe only recorded failure details; do not infer causes or suggest that you changed anything.\n\n${JSON.stringify(facts, null, 2)}`,
      );
    },
  });

  return sendSuccess(res, 200, summary);
});

app.post("/tenants/:id/webhook-endpoints", async (req, res) => {
  const { id: tenantId } = req.params;
  const url = req.body?.url;

  if (typeof url !== "string" || url.trim().length === 0) {
    return sendError(res, 400, "VALIDATION_ERROR", "Webhook URL is required");
  }

  let parsedUrl;

  try {
    parsedUrl = parseWebhookUrl(url);
  } catch (error) {
    return sendError(res, 400, "VALIDATION_ERROR", error.message);
  }

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      tenantId,
      url: parsedUrl.toString(),
    },
  });

  return sendSuccess(res, 201, {
    id: endpoint.id,
    tenantId: endpoint.tenantId,
    url: endpoint.url,
    enabled: endpoint.enabled,
    createdAt: endpoint.createdAt,
  });
});

// Persist an event, its deliveries, and its Kafka publication intent atomically.
app.post("/tenants/:id/events", async (req, res) => {
  const { id: tenantId } = req.params;
  const { eventType, payload } = req.body ?? {};

  if (typeof eventType !== "string" || eventType.trim().length === 0) {
    return sendError(res, 400, "VALIDATION_ERROR", "Event type is required");
  }

  if (payload === undefined || payload === null || typeof payload !== "object") {
    return sendError(res, 400, "VALIDATION_ERROR", "Event payload must be a JSON object or array");
  }

  const result = await prisma.$transaction(async (tx) => {
    const event = await tx.event.create({
      data: {
        tenantId,
        eventType: eventType.trim(),
        payload,
      },
    });

    const endpoints = await tx.webhookEndpoint.findMany({
      where: {
        tenantId,
        enabled: true,
      },
      select: {
        id: true,
      },
    });

    const deliveryResult =
      endpoints.length === 0
        ? { count: 0 }
        : await tx.webhookDelivery.createMany({
            data: endpoints.map((endpoint) => ({
              eventId: event.id,
              endpointId: endpoint.id,
            })),
          });

    await tx.eventOutbox.create({
      data: {
        eventId: event.id,
      },
    });

    return { event, deliveryCount: deliveryResult.count };
  });

  return sendSuccess(res, 201, {
    id: result.event.id,
    tenantId: result.event.tenantId,
    eventType: result.event.eventType,
    payload: result.event.payload,
    createdAt: result.event.createdAt,
    deliveryCount: result.deliveryCount,
  });
});

// Retrieve delivery history for one event.
app.get("/tenants/:id/events/:eventId/deliveries", async (req, res) => {
  const { id: tenantId, eventId } = req.params;
  const pagination = parsePagination(req.query);

  if (pagination.error) {
    return sendError(res, 400, "VALIDATION_ERROR", pagination.error);
  }

  const event = await prisma.event.findFirst({
    where: {
      id: eventId,
      tenantId,
    },
    select: {
      id: true,
    },
  });

  if (!event) {
    return sendError(res, 404, "EVENT_NOT_FOUND", "Event not found");
  }

  const where = { eventId };

  if (pagination.cursor) {
    where.OR = [
      { createdAt: { gt: pagination.cursor.createdAt } },
      {
        createdAt: pagination.cursor.createdAt,
        id: { gt: pagination.cursor.id },
      },
    ];
  }

  const records = await prisma.webhookDelivery.findMany({
    where,
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: pagination.limit + 1,
    select: {
      id: true,
      eventId: true,
      endpointId: true,
      status: true,
      attemptCount: true,
      lastAttemptAt: true,
      nextAttemptAt: true,
      deliveredAt: true,
      lastStatusCode: true,
      lastError: true,
      createdAt: true,
      updatedAt: true,
      endpoint: {
        select: {
          url: true,
        },
      },
    },
  });

  const hasMore = records.length > pagination.limit;
  const deliveries = records.slice(0, pagination.limit);
  const lastDelivery = deliveries.at(-1);

  return sendSuccess(res, 200, {
    deliveries: deliveries.map((delivery) => ({
      id: delivery.id,
      eventId: delivery.eventId,
      endpointId: delivery.endpointId,
      endpointUrl: delivery.endpoint.url,
      status: delivery.status,
      attemptCount: delivery.attemptCount,
      lastAttemptAt: delivery.lastAttemptAt,
      nextAttemptAt: delivery.nextAttemptAt,
      deliveredAt: delivery.deliveredAt,
      lastStatusCode: delivery.lastStatusCode,
      lastError: delivery.lastError,
      createdAt: delivery.createdAt,
      updatedAt: delivery.updatedAt,
    })),
    pagination: {
      limit: pagination.limit,
      hasMore,
      nextCursor: hasMore && lastDelivery ? encodePaginationCursor(lastDelivery) : null,
    },
  });
});

app.get("/tenants/:id/events", async (req, res) => {
  const { id: tenantId } = req.params;
  const pagination = parsePagination(req.query);

  if (pagination.error) {
    return sendError(res, 400, "VALIDATION_ERROR", pagination.error);
  }

  const where = { tenantId };

  if (pagination.cursor) {
    where.OR = [
      { createdAt: { lt: pagination.cursor.createdAt } },
      {
        createdAt: pagination.cursor.createdAt,
        id: { lt: pagination.cursor.id },
      },
    ];
  }

  const records = await prisma.event.findMany({
    where,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: pagination.limit + 1,
    select: {
      id: true,
      tenantId: true,
      eventType: true,
      payload: true,
      createdAt: true,
    },
  });

  const hasMore = records.length > pagination.limit;
  const events = records.slice(0, pagination.limit);
  const lastEvent = events.at(-1);

  return sendSuccess(res, 200, {
    events,
    pagination: {
      limit: pagination.limit,
      hasMore,
      nextCursor: hasMore && lastEvent ? encodePaginationCursor(lastEvent) : null,
    },
  });
});

app.use((req, res) => {
  return sendError(res, 404, "NOT_FOUND", "Route not found");
});

// Express requires four parameters to register error-handling middleware.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err?.type === "entity.too.large") {
    return sendError(res, 413, "PAYLOAD_TOO_LARGE", "Request body must not exceed 1 MB");
  }

  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return sendError(res, 400, "INVALID_JSON", "Request body must contain valid JSON");
  }

  logger.error("request_failed", {
    requestId: req.requestId,
    method: req.method,
    route: req.route?.path ?? "unmatched",
    error: err,
  });
  return sendError(res, 500, "INTERNAL_SERVER_ERROR", "An unexpected error occurred");
});

export default app;
