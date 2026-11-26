import { prisma } from "../db/prisma.js";
import { publishEvent } from "./event-producer.js";
import { logger } from "../observability/logger.js";
import { recordBackgroundOperation } from "../observability/metrics.js";

const STALE_CLAIM_MS = 30_000;
const DEFAULT_BATCH_SIZE = 25;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;
const MAX_ERROR_LENGTH = 1000;

export async function publishOutboxBatch({
  db = prisma,
  publish = publishEvent,
  now = new Date(),
  batchSize = DEFAULT_BATCH_SIZE,
  staleClaimMs = STALE_CLAIM_MS,
} = {}) {
  const staleBefore = new Date(now.getTime() - staleClaimMs);

  const records = await db.eventOutbox.findMany({
    where: {
      OR: [
        {
          status: "PENDING",
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        {
          status: "PROCESSING",
          updatedAt: { lte: staleBefore },
        },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: batchSize,
    include: { event: true },
  });

  let claimed = 0;
  let published = 0;
  let deferred = 0;

  for (const record of records) {
    const claim = await db.eventOutbox.updateMany({
      where: {
        id: record.id,
        OR: [
          {
            status: "PENDING",
            OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
          },
          {
            status: "PROCESSING",
            updatedAt: { lte: staleBefore },
          },
        ],
      },
      data: {
        status: "PROCESSING",
        attemptCount: { increment: 1 },
        nextAttemptAt: null,
        lastError: null,
      },
    });

    if (claim.count !== 1) {
      continue;
    }

    claimed += 1;
    const attemptCount = record.attemptCount + 1;
    const event = record.event;

    try {
      await publish({
        id: event.id,
        tenantId: event.tenantId,
        eventType: event.eventType,
        payload: event.payload,
        createdAt: event.createdAt,
      });

      await db.eventOutbox.updateMany({
        where: {
          id: record.id,
          status: "PROCESSING",
          attemptCount,
        },
        data: {
          status: "PUBLISHED",
          publishedAt: new Date(),
          nextAttemptAt: null,
          lastError: null,
        },
      });

      published += 1;
      recordBackgroundOperation({
        component: "kafka_outbox",
        operation: "publish",
        outcome: "published",
      });
      logger.info("outbox_event_published", {
        eventId: event.id,
        outboxId: record.id,
        attemptCount,
      });
    } catch (error) {
      const retryDelayMs = Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** Math.min(attemptCount - 1, 9));

      await db.eventOutbox.updateMany({
        where: {
          id: record.id,
          status: "PROCESSING",
          attemptCount,
        },
        data: {
          status: "PENDING",
          nextAttemptAt: new Date(now.getTime() + retryDelayMs),
          lastError: String(error?.message || error).slice(0, MAX_ERROR_LENGTH),
        },
      });

      deferred += 1;
      recordBackgroundOperation({
        component: "kafka_outbox",
        operation: "publish",
        outcome: "deferred",
      });
      logger.warn("outbox_event_deferred", {
        eventId: event.id,
        outboxId: record.id,
        attemptCount,
        error,
      });
    }
  }

  return { claimed, published, deferred };
}
