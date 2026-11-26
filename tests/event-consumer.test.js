import { test } from "node:test";
import assert from "node:assert/strict";

import { getValidEventId } from "../src/kafka/event-consumer.js";

const validEventId = "550e8400-e29b-41d4-a716-446655440000";

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
