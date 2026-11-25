import express from "express";
import { prisma } from "./db/prisma.js";
import { eventQueue } from "./queue/event-queue.js";

const app = express();

app.use(express.json());

// Send every successful response in a consistent format.
function sendSuccess(res, statusCode, data) {
  return res.status(statusCode).json({ data });
}

// Send every error response in a consistent format.
function sendError(res, statusCode, code, message) {
  return res.status(statusCode).json({
    error: {
      code,
      message,
    },
  });
}

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

  const tenant = await prisma.tenant.create({
    data: {
      name: name.trim(),
    },
  });

  return sendSuccess(res, 201, {
    id: tenant.id,
    name: tenant.name,
    createdAt: tenant.createdAt,
  });
});

app.get("/tenants/:id", async (req, res) => {
  const { id } = req.params;

  const tenant = await prisma.tenant.findUnique({
    where: { id },
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

app.post("/tenants/:id/events", async (req, res) => {
  const { id: tenantId } = req.params;
  const { eventType, payload } = req.body ?? {};

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true },
  });

  if (!tenant) {
    return sendError(res, 404, "TENANT_NOT_FOUND", "Tenant not found");
  }

  if (typeof eventType !== "string" || eventType.trim().length === 0) {
    return sendError(res, 400, "VALIDATION_ERROR", "Event type is required");
  }

  if (payload === undefined || payload === null || typeof payload !== "object") {
    return sendError(res, 400, "VALIDATION_ERROR", "Event payload must be a JSON object or array");
  }

  // First, persist the event in PostgreSQL.
  const event = await prisma.event.create({
    data: {
      tenantId,
      eventType: eventType.trim(),
      payload,
    },
  });

  // Then, enqueue a background job for this event.
  await eventQueue.add(
    "process-event",
    {
      eventId: event.id,
      tenantId: event.tenantId,
      eventType: event.eventType,
      payload: event.payload,
    },
    {
      jobId: event.id,
    },
  );

  return sendSuccess(res, 201, {
    id: event.id,
    tenantId: event.tenantId,
    eventType: event.eventType,
    payload: event.payload,
    createdAt: event.createdAt,
  });
});

app.get("/tenants/:id/events", async (req, res) => {
  const { id: tenantId } = req.params;

  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true },
  });

  if (!tenant) {
    return sendError(res, 404, "TENANT_NOT_FOUND", "Tenant not found");
  }

  const events = await prisma.event.findMany({
    where: { tenantId },
    orderBy: { createdAt: "desc" },
  });

  return sendSuccess(res, 200, {
    events: events.map((event) => ({
      id: event.id,
      tenantId: event.tenantId,
      eventType: event.eventType,
      payload: event.payload,
      createdAt: event.createdAt,
    })),
  });
});

// Handle requests that don't match any route.
app.use((req, res) => {
  return sendError(res, 404, "NOT_FOUND", "Route not found");
});

// Handle errors from routes and middleware.
app.use((err, req, res, next) => {
  console.error(err);

  return sendError(res, 500, "INTERNAL_SERVER_ERROR", "An unexpected error occurred");
});

export default app;
