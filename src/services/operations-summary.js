const DELIVERY_STATUSES = ["PENDING", "PROCESSING", "DELIVERED", "FAILED"];
const RECENT_FAILURE_LIMIT = 5;
const FAILURE_REASON_MAX_LENGTH = 220;
const HOURS_24_MS = 24 * 60 * 60 * 1000;

export function sanitizeFailureReason(value) {
  if (typeof value !== "string" || value.trim().length === 0) {
    return null;
  }

  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/(api[_-]?key|token|secret|password)=\S+/gi, "$1=[redacted]")
    .replace(/https?:\/\/\S+/gi, "[webhook URL]")
    .replace(/[\r\n\t]+/g, " ")
    .trim()
    .slice(0, FAILURE_REASON_MAX_LENGTH);
}

export function buildOperationsFacts({
  statusCounts,
  totalDeliveries,
  recentFailureCount,
  recentFailures,
  generatedAt,
}) {
  const counts = Object.fromEntries(
    DELIVERY_STATUSES.map((status) => [status, statusCounts[status] || 0]),
  );

  return {
    generatedAt: generatedAt.toISOString(),
    totalDeliveries,
    deliveryCounts: counts,
    recentFailureCount,
    recentFailures: recentFailures.map((delivery) => ({
      eventType: delivery.event.eventType,
      status: delivery.status,
      attemptCount: delivery.attemptCount,
      lastStatusCode: delivery.lastStatusCode,
      failureReason: sanitizeFailureReason(delivery.lastError),
      updatedAt: delivery.updatedAt.toISOString(),
    })),
  };
}

export function buildDeterministicNarrative(facts) {
  if (facts.totalDeliveries === 0) {
    return "No webhook deliveries have been recorded for this tenant yet.";
  }

  const counts = facts.deliveryCounts;
  const sentences = [
    `RelayForge has recorded ${facts.totalDeliveries} webhook deliveries: ${counts.DELIVERED} delivered, ${counts.PENDING} pending, ${counts.PROCESSING} processing, and ${counts.FAILED} failed.`,
  ];

  if (facts.recentFailureCount > 0) {
    sentences.push(
      `${facts.recentFailureCount} delivery record(s) have a failure or error recorded in the last 24 hours.`,
    );
  } else {
    sentences.push("No delivery failures or recorded errors were found in the last 24 hours.");
  }

  return sentences.join(" ");
}

export async function getTenantOperationsSummary(
  prisma,
  tenantId,
  { generateNarrative, now = new Date() } = {},
) {
  const since = new Date(now.getTime() - HOURS_24_MS);
  const failureWhere = {
    event: {
      tenantId,
    },
    updatedAt: {
      gte: since,
    },
    OR: [{ status: "FAILED" }, { lastError: { not: null } }],
  };
  const [groupedStatuses, recentFailureCount, recentFailures] = await Promise.all([
    prisma.webhookDelivery.groupBy({
      by: ["status"],
      where: {
        event: {
          tenantId,
        },
      },
      _count: {
        _all: true,
      },
    }),
    prisma.webhookDelivery.count({
      where: failureWhere,
    }),
    prisma.webhookDelivery.findMany({
      where: failureWhere,
      orderBy: {
        updatedAt: "desc",
      },
      take: RECENT_FAILURE_LIMIT,
      select: {
        status: true,
        attemptCount: true,
        lastStatusCode: true,
        lastError: true,
        updatedAt: true,
        event: {
          select: {
            eventType: true,
          },
        },
      },
    }),
  ]);

  const statusCounts = Object.fromEntries(
    groupedStatuses.map((entry) => [entry.status, entry._count._all]),
  );
  const totalDeliveries = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);
  const facts = buildOperationsFacts({
    statusCounts,
    totalDeliveries,
    recentFailureCount,
    recentFailures,
    generatedAt: now,
  });
  const deterministicNarrative = buildDeterministicNarrative(facts);

  let assistant = {
    provider: process.env.AI_PROVIDER || "ollama",
    status: "fallback",
    text: deterministicNarrative,
  };

  if (generateNarrative) {
    try {
      const text = await generateNarrative(facts);
      assistant = {
        provider: process.env.AI_PROVIDER || "ollama",
        status: "generated",
        text,
      };
    } catch {
      assistant.status = "unavailable";
    }
  }

  return {
    facts,
    assistant,
    note: "Delivery counts are database facts. The assistant narrative is a generated summary and does not perform operations.",
  };
}
