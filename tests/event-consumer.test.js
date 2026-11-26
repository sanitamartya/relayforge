import { Buffer } from "node:buffer";
import { test } from "node:test";
import assert from "node:assert/strict";

import { getValidEventId } from "../src/kafka/event-id.js";
import { createKafkaEventMessageHandler } from "../src/kafka/event-message-handler.js";

const validEventId = "550e8400-e29b-41d4-a716-446655440000";

function createHandlerHarness({ deliveries = [{ id: "delivery-1" }, { id: "delivery-2" }] } = {}) {
  const calls = {
    findMany: [],
    addBulk: [],
    warnings: [],
    errors: [],
    logs: [],
  };

  const handler = createKafkaEventMessageHandler({
    prisma: {
      webhookDelivery: {
        findMany: async (query) => {
          calls.findMany.push(query);
          return deliveries;
        },
      },
    },
    eventQueue: {
      addBulk: async (jobs) => {
        calls.addBulk.push(jobs);
      },
    },
    deliveryJobOptions: {
      attempts: 3,
    },
    logger: {
      warn: (message) => calls.warnings.push(message),
      error: (message) => calls.errors.push(message),
      info: (message, fields) => calls.logs.push({ message, fields }),
    },
  });

  return { handler, calls };
}

test("Kafka event ID validation rejects null and undefined payloads", () => {
  assert.equal(getValidEventId(null), null);
  assert.equal(getValidEventId(undefined), null);
});

test("Kafka event ID validation rejects arrays and primitive payloads", () => {
  assert.equal(getValidEventId([]), null);
  assert.equal(getValidEventId("event"), null);
  assert.equal(getValidEventId(123), null);
  assert.equal(getValidEventId(true), null);
});

test("Kafka event ID validation rejects objects without an event ID", () => {
  assert.equal(getValidEventId({ eventType: "order.created" }), null);
});

test("Kafka event ID validation rejects malformed UUIDs", () => {
  assert.equal(getValidEventId({ id: "not-a-uuid" }), null);
  assert.equal(getValidEventId({ id: "550e8400-e29b-01d4-a716-446655440000" }), null);
});

test("Kafka event ID validation accepts a valid id field", () => {
  assert.equal(getValidEventId({ id: validEventId }), validEventId);
});

test("Kafka event ID validation accepts the eventId compatibility field", () => {
  assert.equal(getValidEventId({ eventId: validEventId }), validEventId);
});

test("Kafka event ID validation prefers id when both fields are present", () => {
  assert.equal(
    getValidEventId({
      id: validEventId,
      eventId: "not-a-uuid",
    }),
    validEventId,
  );
});

test("Kafka message handler ignores messages without a value", async () => {
  const { handler, calls } = createHandlerHarness();

  await handler({ message: { value: null } });

  assert.equal(calls.warnings.length, 1);
  assert.equal(calls.findMany.length, 0);
  assert.equal(calls.addBulk.length, 0);
});

test("Kafka message handler ignores invalid JSON", async () => {
  const { handler, calls } = createHandlerHarness();

  await handler({ message: { value: Buffer.from("{invalid-json") } });

  assert.deepEqual(calls.warnings, ["kafka_message_invalid_json"]);
  assert.equal(calls.findMany.length, 0);
  assert.equal(calls.addBulk.length, 0);
});

test("Kafka message handler ignores events with invalid IDs", async () => {
  const { handler, calls } = createHandlerHarness();

  await handler({
    message: {
      value: Buffer.from(JSON.stringify({ id: "bad-id" })),
    },
  });

  assert.deepEqual(calls.warnings, ["kafka_event_invalid_id"]);
  assert.equal(calls.findMany.length, 0);
  assert.equal(calls.addBulk.length, 0);
});

test("Kafka message handler queues pending deliveries for a valid event", async () => {
  const { handler, calls } = createHandlerHarness();

  await handler({
    message: {
      value: Buffer.from(JSON.stringify({ id: validEventId })),
    },
  });

  assert.equal(calls.findMany.length, 1);
  assert.equal(calls.findMany[0].where.eventId, validEventId);
  assert.equal(calls.findMany[0].where.status, "PENDING");
  assert.equal(calls.findMany[0].where.OR.length, 2);
  assert.equal(calls.addBulk.length, 1);
  assert.deepEqual(calls.addBulk[0], [
    {
      name: "deliver-webhook",
      data: { deliveryId: "delivery-1" },
      opts: { attempts: 3, jobId: "delivery-1" },
    },
    {
      name: "deliver-webhook",
      data: { deliveryId: "delivery-2" },
      opts: { attempts: 3, jobId: "delivery-2" },
    },
  ]);
  assert.deepEqual(calls.logs, [
    {
      message: "kafka_event_deliveries_queued",
      fields: { eventId: validEventId, deliveryCount: 2 },
    },
  ]);
});

test("Kafka message handler does not queue when no pending deliveries exist", async () => {
  const { handler, calls } = createHandlerHarness({ deliveries: [] });

  await handler({
    message: {
      value: Buffer.from(JSON.stringify({ id: validEventId })),
    },
  });

  assert.equal(calls.findMany.length, 1);
  assert.equal(calls.addBulk.length, 0);
  assert.deepEqual(calls.logs, [
    {
      message: "kafka_event_deliveries_queued",
      fields: { eventId: validEventId, deliveryCount: 0 },
    },
  ]);
});

test("Kafka message handler propagates database errors", async () => {
  const databaseError = new Error("database unavailable");
  const handler = createKafkaEventMessageHandler({
    prisma: {
      webhookDelivery: {
        findMany: async () => {
          throw databaseError;
        },
      },
    },
    eventQueue: {
      addBulk: async () => {
        assert.fail("queue should not be called after a database error");
      },
    },
    deliveryJobOptions: {},
    logger: {
      warn: () => {},
      error: () => {},
      info: () => {},
    },
  });

  await assert.rejects(
    handler({
      message: {
        value: Buffer.from(JSON.stringify({ id: validEventId })),
      },
    }),
    databaseError,
  );
});
