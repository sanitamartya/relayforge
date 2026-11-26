import "dotenv/config";
import { Kafka } from "kafkajs";

const brokersValue = process.env.KAFKA_BROKERS;
const clientId = process.env.KAFKA_CLIENT_ID;

if (!brokersValue) {
  throw new Error("KAFKA_BROKERS is not configured");
}

if (!clientId) {
  throw new Error("KAFKA_CLIENT_ID is not configured");
}

const brokers = brokersValue
  .split(",")
  .map((broker) => broker.trim())
  .filter(Boolean);

if (brokers.length === 0) {
  throw new Error("KAFKA_BROKERS must contain at least one broker");
}

export const kafka = new Kafka({
  clientId,
  brokers,
});
