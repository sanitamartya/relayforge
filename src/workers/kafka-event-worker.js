/* global setInterval, clearInterval, setTimeout */
import { prisma } from "../db/prisma.js";
import { eventQueue } from "../queue/event-queue.js";
import { publishOutboxBatch } from "../kafka/outbox-publisher.js";
import { disconnectKafkaProducer } from "../kafka/event-producer.js";
import { startKafkaEventConsumer, stopKafkaEventConsumer } from "../kafka/event-consumer.js";
import { logger } from "../observability/logger.js";
import { recordBackgroundOperation } from "../observability/metrics.js";

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
      logger.warn("kafka_outbox_batch_deferred", { deferred: result.deferred });
    }
  } catch (error) {
    recordBackgroundOperation({ component: "kafka_outbox", operation: "poll", outcome: "error" });
    logger.error("kafka_outbox_publisher_failed", { error });
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
      recordBackgroundOperation({ component: "kafka_consumer", operation: "connect", outcome: "retrying" });
      logger.error("kafka_consumer_start_failed_retrying", { error });

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

  logger.info("kafka_event_worker_shutdown_started");

  if (outboxInterval) {
    clearInterval(outboxInterval);
  }

  try {
    await stopKafkaEventConsumer();
    await disconnectKafkaProducer();
    await eventQueue.close();
    await prisma.$disconnect();

    logger.info("kafka_event_worker_stopped");
    process.exit(0);
  } catch (error) {
    logger.error("kafka_event_worker_shutdown_failed", { error });
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
