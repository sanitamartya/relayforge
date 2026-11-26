import { getValidEventId } from "./event-id.js";
import { logger as structuredLogger } from "../observability/logger.js";
import { recordBackgroundOperation } from "../observability/metrics.js";

export function createKafkaEventMessageHandler({
  prisma,
  eventQueue,
  deliveryJobOptions,
  logger = structuredLogger,
}) {
  return async ({ message }) => {
    if (!message?.value) {
      logger.warn("kafka_message_missing_value");
      recordBackgroundOperation({
        component: "kafka_consumer",
        operation: "handle_message",
        outcome: "invalid_message",
      });
      return;
    }

    let event;

    try {
      event = JSON.parse(message.value.toString());
    } catch (error) {
      logger.warn("kafka_message_invalid_json", { error });
      recordBackgroundOperation({
        component: "kafka_consumer",
        operation: "handle_message",
        outcome: "invalid_message",
      });
      return;
    }

    const eventId = getValidEventId(event);

    if (!eventId) {
      logger.warn("kafka_event_invalid_id");
      recordBackgroundOperation({
        component: "kafka_consumer",
        operation: "handle_message",
        outcome: "invalid_event",
      });
      return;
    }

    try {
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

      if (deliveries.length > 0) {
        await eventQueue.addBulk(
          deliveries.map((delivery) => ({
            name: "deliver-webhook",
            data: {
              deliveryId: delivery.id,
            },
            opts: {
              ...deliveryJobOptions,
              jobId: delivery.id,
            },
          })),
        );
      }

      const outcome = deliveries.length > 0 ? "queued" : "no_pending_deliveries";
      recordBackgroundOperation({
        component: "kafka_consumer",
        operation: "queue_deliveries",
        outcome,
      });
      logger.info("kafka_event_deliveries_queued", {
        eventId,
        deliveryCount: deliveries.length,
      });
    } catch (error) {
      recordBackgroundOperation({
        component: "kafka_consumer",
        operation: "handle_message",
        outcome: "error",
      });
      logger.error("kafka_event_processing_failed", { eventId, error });
      throw error;
    }
  };
}
