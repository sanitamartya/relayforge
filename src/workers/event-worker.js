/* global setInterval, clearInterval */
import { Worker } from "bullmq";
import { prisma } from "../db/prisma.js";
import { redisConnection } from "../queue/redis-connection.js";
import { eventQueue, deliveryJobOptions } from "../queue/event-queue.js";
import { processDelivery } from "./delivery-processor.js";

const QUEUE_NAME = "relayforge-event-processing";
const DISPATCH_INTERVAL_MS = 5000;
const STALE_PROCESSING_MS = 60_000;
const DISPATCH_BATCH_SIZE = 100;

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
  },
);

worker.on("completed", (job, result) => {
  console.log(`Delivery job ${job.id} completed`, result);
});

worker.on("failed", async (job, error) => {
  console.error(`Delivery job ${job?.id} failed:`, error.message);

  if (!job) {
    return;
  }

  const maxAttempts = job.opts.attempts ?? 1;

  // BullMQ retries intermediate failures.
  // Only mark the delivery FAILED after the final attempt.
  if (job.attemptsMade >= maxAttempts) {
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
      console.error("Could not mark delivery as FAILED:", updateError);
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
}

let dispatching = false;

async function runDispatcher() {
  if (dispatching) {
    return;
  }

  dispatching = true;

  try {
    await dispatchPendingDeliveries();
  } catch (error) {
    console.error("Delivery dispatcher failed:", error);
  } finally {
    dispatching = false;
  }
}

const dispatcherInterval = setInterval(runDispatcher, DISPATCH_INTERVAL_MS);
dispatcherInterval.unref();

await runDispatcher();

console.log("RelayForge delivery worker is running");

async function shutdown() {
  console.log("Shutting down worker...");

  clearInterval(dispatcherInterval);

  await worker.close();
  await eventQueue.close();
  await prisma.$disconnect();

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
