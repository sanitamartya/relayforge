/* global setInterval, clearInterval, setTimeout */
import { prisma } from "../db/prisma.js";
import { eventQueue } from "../queue/event-queue.js";
import { publishOutboxBatch } from "../kafka/outbox-publisher.js";
import { disconnectKafkaProducer } from "../kafka/event-producer.js";
import { startKafkaEventConsumer, stopKafkaEventConsumer } from "../kafka/event-consumer.js";

const OUTBOX_POLL_INTERVAL_MS = 1000;
const CONSUMER_RETRY_INTERVAL_MS = 5000;

let shuttingDown = false;
let publishing = false;
let outboxInterval;

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

async function startConsumerWithRetry() {
  while (!shuttingDown) {
    try {
      await startKafkaEventConsumer();
      return;
    } catch (error) {
      console.error("Kafka consumer failed to start; retrying:", error.message);

      try {
        await stopKafkaEventConsumer();
      } catch {
        // A failed initial connection may not have an active consumer session.
      }

      await new Promise((resolve) => setTimeout(resolve, CONSUMER_RETRY_INTERVAL_MS));
    }
  }
}

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
    await disconnectKafkaProducer();
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

// Keep the publisher alive through Kafka outages; publication failures stay in
// PostgreSQL and are retried by the outbox scheduler.
await runOutboxPublisher();
outboxInterval = setInterval(runOutboxPublisher, OUTBOX_POLL_INTERVAL_MS);
outboxInterval.unref();

void startConsumerWithRetry();
