/* global setInterval, clearInterval */
import "dotenv/config";
import { Worker } from "bullmq";
import { prisma } from "../db/prisma.js";
import { redisConnection } from "../queue/redis-connection.js";
import { eventQueue, deliveryJobOptions } from "../queue/event-queue.js";
import { processDelivery } from "./delivery-processor.js";
import { logger } from "../observability/logger.js";
import { recordBackgroundOperation } from "../observability/metrics.js";
import { parseWorkerConcurrency } from "./worker-config.js";

const QUEUE_NAME = "relayforge-event-processing";
const DISPATCH_INTERVAL_MS = 5000;
const STALE_PROCESSING_MS = 60_000;
const DISPATCH_BATCH_SIZE = 100;
const workerConcurrency = parseWorkerConcurrency(process.env.WEBHOOK_WORKER_CONCURRENCY);

const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    if (job.name !== "deliver-webhook") {
      throw new Error(`Unsupported job type: ${job.name}`);
    }

    return processDelivery(job.data.deliveryId);
  },
  {
    connection: redisConnection,
    concurrency: workerConcurrency,
  },
);

worker.on("completed", (job, result) => {
  const outcome = result?.delivered ? "delivered" : "skipped";

  recordBackgroundOperation({
    component: "webhook_delivery",
    operation: "process",
    outcome,
  });
  logger.info("delivery_job_completed", {
    jobId: job.id,
    deliveryId: job.data.deliveryId,
    result,
  });
});

worker.on("failed", async (job, error) => {
  if (!job) {
    recordBackgroundOperation({
      component: "webhook_delivery",
      operation: "process",
      outcome: "unknown_failure",
    });
    logger.error("delivery_job_failed_without_job", { error });
    return;
  }

  const maxAttempts = job.opts.attempts ?? 1;
  const terminalFailure = job.attemptsMade >= maxAttempts;

  recordBackgroundOperation({
    component: "webhook_delivery",
    operation: "process",
    outcome: terminalFailure ? "terminal_failure" : "retrying",
  });
  logger.error("delivery_job_failed", {
    jobId: job.id,
    deliveryId: job.data.deliveryId,
    attemptsMade: job.attemptsMade,
    maxAttempts,
    terminalFailure,
    error,
  });

  // BullMQ retries intermediate failures.
  // Only mark the delivery FAILED after the final attempt.
  if (terminalFailure) {
    try {
      await prisma.webhookDelivery.updateMany({
        where: {
          id: job.data.deliveryId,
          status: {
            not: "DELIVERED",
          },
        },
        data: {
          status: "FAILED",
          nextAttemptAt: null,
          lastError: error.message.slice(0, 1000),
        },
      });
    } catch (updateError) {
      logger.error("delivery_mark_failed_update_error", {
        deliveryId: job.data.deliveryId,
        error: updateError,
      });
    }
  }
});

// Recover pending delivery records that are not currently queued.
async function dispatchPendingDeliveries() {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);

  const deliveries = await prisma.webhookDelivery.findMany({
    where: {
      OR: [
        {
          status: "PENDING",
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
        },
        {
          status: "PROCESSING",
          updatedAt: {
            lte: staleBefore,
          },
        },
      ],
    },
    orderBy: {
      createdAt: "asc",
    },
    take: DISPATCH_BATCH_SIZE,
    select: {
      id: true,
      status: true,
    },
  });

  for (const delivery of deliveries) {
    if (delivery.status === "PROCESSING") {
      await prisma.webhookDelivery.updateMany({
        where: {
          id: delivery.id,
          status: "PROCESSING",
          updatedAt: {
            lte: staleBefore,
          },
        },
        data: {
          status: "PENDING",
          lastError: "Recovered stale processing delivery",
        },
      });
    }

    await eventQueue.add(
      "deliver-webhook",
      {
        deliveryId: delivery.id,
      },
      {
        ...deliveryJobOptions,
        jobId: delivery.id,
      },
    );
  }
  return deliveries.length;
}

let dispatching = false;

async function runDispatcher() {
  if (dispatching) {
    return;
  }

  dispatching = true;

  try {
    const dispatched = await dispatchPendingDeliveries();

    if (dispatched > 0) {
      recordBackgroundOperation({
        component: "delivery_dispatcher",
        operation: "dispatch",
        outcome: "queued",
      });
      logger.info("delivery_dispatch_batch_queued", { count: dispatched });
    }
  } catch (error) {
    recordBackgroundOperation({
      component: "delivery_dispatcher",
      operation: "dispatch",
      outcome: "error",
    });
    logger.error("delivery_dispatcher_failed", { error });
  } finally {
    dispatching = false;
  }
}

const dispatcherInterval = setInterval(runDispatcher, DISPATCH_INTERVAL_MS);
dispatcherInterval.unref();

await runDispatcher();

logger.info("delivery_worker_started");

async function shutdown() {
  logger.info("delivery_worker_shutdown_started");

  clearInterval(dispatcherInterval);

  await worker.close();
  await eventQueue.close();
  await prisma.$disconnect();

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
