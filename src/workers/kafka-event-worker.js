/* global setInterval, clearInterval */
import { prisma } from "../db/prisma.js";
import { eventQueue } from "../queue/event-queue.js";
import { publishOutboxBatch } from "../kafka/outbox-publisher.js";
import { startKafkaEventConsumer, stopKafkaEventConsumer } from "../kafka/event-consumer.js";

const OUTBOX_POLL_INTERVAL_MS = 1000;

let shuttingDown = false;
let publishing = false;

async function runOutboxPublisher() {
  if (publishing || shuttingDown) {
    return;
  }

  publishing = true;

  try {
    const result = await publishOutboxBatch();

    if (result.deferred > 0) {
      console.warn(`Kafka outbox deferred ${result.deferred} event(s) for retry`);
    }
  } catch (error) {
    console.error("Kafka outbox publisher failed:", error);
  } finally {
    publishing = false;
  }
}

let outboxInterval;

async function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log("Shutting down Kafka event worker...");

  if (outboxInterval) {
    clearInterval(outboxInterval);
  }

  try {
    await stopKafkaEventConsumer();
    await eventQueue.close();
    await prisma.$disconnect();

    console.log("Kafka event worker stopped");
    process.exit(0);
  } catch (error) {
    console.error("Kafka event worker shutdown failed:", error);
    process.exit(1);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  await startKafkaEventConsumer();
  await runOutboxPublisher();
  outboxInterval = setInterval(runOutboxPublisher, OUTBOX_POLL_INTERVAL_MS);
  outboxInterval.unref();
} catch (error) {
  console.error("Kafka event worker failed to start:", error);
  await shutdown();
}
