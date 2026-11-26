import { publishEvent, disconnectKafkaProducer } from "../src/kafka/event-producer.js";

try {
  const event = {
    id: "relayforge-kafka-test-001",
    type: "test.kafka.message",
    message: "Hello from RelayForge",
    createdAt: new Date().toISOString(),
  };

  const result = await publishEvent(event);

  console.log("Kafka message published successfully:");
  console.log(result);
} catch (error) {
  console.error("Kafka producer test failed:", error);
  process.exitCode = 1;
} finally {
  await disconnectKafkaProducer();
}
