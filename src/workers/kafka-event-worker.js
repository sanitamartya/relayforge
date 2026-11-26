import { prisma } from "../db/prisma.js";
import { eventQueue } from "../queue/event-queue.js";
import { startKafkaEventConsumer, stopKafkaEventConsumer } from "../kafka/event-consumer.js";

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  console.log("Shutting down Kafka event consumer...");

  try {
    await stopKafkaEventConsumer();
    await eventQueue.close();
    await prisma.$disconnect();

    console.log("Kafka event consumer stopped");
    process.exit(0);
  } catch (error) {
    console.error("Kafka consumer shutdown failed:", error);
    process.exit(1);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

try {
  await startKafkaEventConsumer();
} catch (error) {
  console.error("Kafka event consumer failed to start:", error);
  await shutdown();
}
