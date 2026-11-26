import { getValidEventId } from "./event-id.js";

export function createKafkaEventMessageHandler({
  prisma,
  eventQueue,
  deliveryJobOptions,
  logger = console,
}) {
  return async ({ message }) => {
    if (!message?.value) {
      logger.warn("Kafka message has no value");
      return;
    }

    let event;

    try {
      event = JSON.parse(message.value.toString());
    } catch {
      logger.error("Kafka message contains invalid JSON");
      return;
    }

    const eventId = getValidEventId(event);

    if (!eventId) {
      logger.error("Kafka event contains an invalid UUID event ID");
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

    logger.log(`Kafka event ${eventId}: queued ${deliveries.length} deliveries`);
  };
}
