import { test } from "node:test";
import assert from "node:assert/strict";

import {
  publishEvent,
  disconnectKafkaProducer,
  createKafkaEventPublisher,
} from "../src/kafka/event-producer.js";

function createFakeProducer() {
  const calls = {
    connect: 0,
    disconnect: 0,
    send: [],
  };

  return {
    calls,
    async connect() {
      calls.connect += 1;
    },
    async disconnect() {
      calls.disconnect += 1;
    },
    async send(message) {
      calls.send.push(message);
      return [{ topicName: "relayforge-events" }];
    },
  };
}

test("publishEvent rejects null", async () => {
  await assert.rejects(publishEvent(null), /Event must be an object/);
});

test("publishEvent rejects undefined", async () => {
  await assert.rejects(publishEvent(undefined), /Event must be an object/);
});

test("publishEvent rejects primitive values", async () => {
  await assert.rejects(publishEvent("invalid"), /Event must be an object/);
});

test("publishEvent rejects arrays", async () => {
  await assert.rejects(publishEvent([]), /Event must be an object/);
});

test("disconnectKafkaProducer safely returns when not connected", async () => {
  await assert.doesNotReject(disconnectKafkaProducer());
});

test("publisher connects once and sends an event with its ID as key", async () => {
  const producer = createFakeProducer();
  const publisher = createKafkaEventPublisher(producer);
  const event = {
    id: "event-123",
    eventType: "order.created",
    payload: { orderId: "order-123" },
  };

  const result = await publisher.publishEvent(event);
  await publisher.publishEvent(event);

  assert.equal(producer.calls.connect, 1);
  assert.equal(producer.calls.send.length, 2);
  assert.deepEqual(producer.calls.send[0], {
    topic: "relayforge-events",
    messages: [
      {
        key: "event-123",
        value: JSON.stringify(event),
      },
    ],
  });
  assert.deepEqual(result, [{ topicName: "relayforge-events" }]);
});

test("publisher uses eventId when id is absent", async () => {
  const producer = createFakeProducer();
  const publisher = createKafkaEventPublisher(producer);

  await publisher.publishEvent({ eventId: "legacy-event-456" });

  assert.equal(producer.calls.send[0].messages[0].key, "legacy-event-456");
});

test("publisher sends an undefined key when event has no ID", async () => {
  const producer = createFakeProducer();
  const publisher = createKafkaEventPublisher(producer);

  await publisher.publishEvent({ eventType: "system.ping" });

  assert.equal(producer.calls.send[0].messages[0].key, undefined);
});

test("publisher disconnects after connecting", async () => {
  const producer = createFakeProducer();
  const publisher = createKafkaEventPublisher(producer);

  await publisher.publishEvent({ id: "event-789" });
  await publisher.disconnectKafkaProducer();

  assert.equal(producer.calls.connect, 1);
  assert.equal(producer.calls.disconnect, 1);
});

test("publisher does not disconnect when it is not connected", async () => {
  const producer = createFakeProducer();
  const publisher = createKafkaEventPublisher(producer);

  await publisher.disconnectKafkaProducer();

  assert.equal(producer.calls.disconnect, 0);
});
