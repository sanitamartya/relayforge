import { kafka } from "./kafka-client.js";

const topic = "relayforge-events";

export function createKafkaEventPublisher(producer) {
  let isConnected = false;

  async function connectKafkaProducer() {
    if (isConnected) {
      return;
    }

    await producer.connect();
    isConnected = true;
  }

  async function publishEvent(event) {
    if (!event || typeof event !== "object" || Array.isArray(event)) {
      throw new Error("Event must be an object");
    }

    await connectKafkaProducer();

    const eventKey = event.id ?? event.eventId ?? null;

    const result = await producer.send({
      topic,
      messages: [
        {
          key: eventKey === null ? undefined : String(eventKey),
          value: JSON.stringify(event),
        },
      ],
    });

    return result;
  }

  async function disconnectKafkaProducer() {
    if (!isConnected) {
      return;
    }

    await producer.disconnect();
    isConnected = false;
  }

  return {
    connectKafkaProducer,
    publishEvent,
    disconnectKafkaProducer,
  };
}

const producer = kafka.producer();

const kafkaEventPublisher = createKafkaEventPublisher(producer);

export const { connectKafkaProducer, publishEvent, disconnectKafkaProducer } = kafkaEventPublisher;
