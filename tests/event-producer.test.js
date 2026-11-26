import { test } from "node:test";
import assert from "node:assert/strict";

import { publishEvent, disconnectKafkaProducer } from "../src/kafka/event-producer.js";

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
