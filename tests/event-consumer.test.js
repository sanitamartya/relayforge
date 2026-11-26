import { test } from "node:test";
import assert from "node:assert/strict";

import { getValidEventId } from "../src/kafka/event-id.js";
import { createKafkaEventMessageHandler } from "../src/kafka/event-message-handler.js";

const validEventId = "550e8400-e29b-41d4-a716-446655440000";

function createHandlerHarness({
  deliveries = [{ id: "delivery-1" }, { id: "delivery-2" }],
} = {}) {
  const calls = {
    findMany: [],
    add: [],
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
      add: async (...args) => {
        calls.add.push(args);
      },
    },
    deliveryJobOptions: {
      attempts: 3,
    },
    logger: {
      warn: (message) => calls.warnings.push(message),
      error: (message) => calls.errors.push(message),
      log: (message) => calls.logs.push(message),
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
  assert.equal(
    getValidEventId({ id: "550e8400-e29b-01d4-a716-446655440000" }),
    null,
  );
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
  assert.equal(calls.add.length, 0);
});

test("Kafka message handler ignores invalid JSON", async () => {
  const { handler, calls } = createHandlerHarness();

  await handler({ message: { value: Buffer.from("{invalid-json") } });

  assert.deepEqual(calls.errors, ["Kafka message contains invalid JSON"]);
  assert.equal(calls.findMany.length, 0);
  assert.equal(calls.add.length, 0);
});

test("Kafka message handler ignores events with invalid IDs", async () => {
  const { handler, calls } = createHandlerHarness();

  await handler({
    message: {
      value: Buffer.from(JSON.stringify({ id: "bad-id" })),
    },
  });

  assert.deepEqual(calls.errors, [
    "Kafka event contains an invalid UUID event ID",
  ]);
  assert.equal(calls.findMany.length, 0);
  assert.equal(calls.add.length, 0);
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
  assert.equal(calls.add.length, 2);
  assert.deepEqual(calls.add[0], [
    "deliver-webhook",
    { deliveryId: "delivery-1" },
    { attempts: 3, jobId: "delivery-1" },
  ]);
  assert.deepEqual(calls.add[1], [
    "deliver-webhook",
    { deliveryId: "delivery-2" },
    { attempts: 3, jobId: "delivery-2" },
  ]);
  assert.deepEqual(calls.logs, [
    "Kafka event " + validEventId + ": queued 2 deliveries",
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
  assert.equal(calls.add.length, 0);
  assert.deepEqual(calls.logs, [
    "Kafka event " + validEventId + ": queued 0 deliveries",
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
      add: async () => {
        assert.fail("queue should not be called after a database error");
      },
    },
    deliveryJobOptions: {},
    logger: {
      warn: () => {},
      error: () => {},
      log: () => {},
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
