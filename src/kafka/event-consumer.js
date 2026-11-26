import { kafka } from "./kafka-client.js";
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
    eachMessage: async ({ message }) => {
      if (!message.value) {
        console.warn("Kafka message has no value");
        return;
      }

      let event;

      try {
        event = JSON.parse(message.value.toString());
      } catch {
        console.error("Kafka message contains invalid JSON");
        return;
      }

      const eventId = event.id ?? event.eventId;

      const uuidPattern =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

      if (typeof eventId !== "string" || !uuidPattern.test(eventId)) {
        console.error("Kafka event contains an invalid UUID event ID");
        return;
      }

      const deliveries = await prisma.webhookDelivery.findMany({
        where: {
          eventId,
          status: "PENDING",
          OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: new Date() } }],
        },
        select: {
          id: true,
        },
      });

      for (const delivery of deliveries) {
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

      console.log(`Kafka event ${eventId}: queued ${deliveries.length} deliveries`);
    },
  });

  console.log("RelayForge Kafka event consumer is running");
}

export async function stopKafkaEventConsumer() {
  await consumer.disconnect();
}
