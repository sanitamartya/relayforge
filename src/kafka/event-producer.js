import { kafka } from "./kafka-client.js";

const producer = kafka.producer();

const topic = "relayforge-events";

let isConnected = false;

export async function connectKafkaProducer() {
  if (isConnected) {
    return;
  }

  await producer.connect();
  isConnected = true;
}

export async function publishEvent(event) {
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

export async function disconnectKafkaProducer() {
  if (!isConnected) {
    return;
  }

  await producer.disconnect();
  isConnected = false;
}
