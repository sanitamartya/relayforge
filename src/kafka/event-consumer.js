import { kafka } from "./kafka-client.js";
import { createKafkaEventMessageHandler } from "./event-message-handler.js";
import { prisma } from "../db/prisma.js";
import { eventQueue, deliveryJobOptions } from "../queue/event-queue.js";

const TOPIC = "relayforge-events";
const GROUP_ID = "relayforge-event-delivery";

const consumer = kafka.consumer({
  groupId: GROUP_ID,
});

export async function startKafkaEventConsumer() {
  await consumer.connect();

  await consumer.subscribe({
    topic: TOPIC,
    fromBeginning: true,
  });

  await consumer.run({
    eachMessage: createKafkaEventMessageHandler({
      prisma,
      eventQueue,
      deliveryJobOptions,
    }),
  });

  console.log("RelayForge Kafka event consumer is running");
}

export async function stopKafkaEventConsumer() {
  await consumer.disconnect();
}
