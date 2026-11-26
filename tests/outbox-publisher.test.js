import { test } from "node:test";
import assert from "node:assert/strict";

import { publishOutboxBatch } from "../src/kafka/outbox-publisher.js";

function createOutboxRecord(overrides = {}) {
  return {
    id: "outbox-123",
    eventId: "event-123",
    status: "PENDING",
    attemptCount: 0,
    event: {
      id: "event-123",
      tenantId: "tenant-123",
      eventType: "order.created",
      payload: { orderId: "order-123" },
      createdAt: new Date("2026-11-26T00:00:00.000Z"),
    },
    ...overrides,
  };
}

function createFakeDb(record, claimCount = 1) {
  const updates = [];

  return {
    updates,
    eventOutbox: {
      async findMany() {
        return record ? [record] : [];
      },
      async updateMany(args) {
        updates.push(args);
        return { count: updates.length === 1 ? claimCount : 1 };
      },
    },
  };
}

test("publishes an outbox event and marks it PUBLISHED", async () => {
  const record = createOutboxRecord();
  const db = createFakeDb(record);
  const publishedEvents = [];

  const result = await publishOutboxBatch({
    db,
    publish: async (event) => publishedEvents.push(event),
  });

  assert.deepEqual(result, { claimed: 1, published: 1, deferred: 0 });
  assert.deepEqual(publishedEvents, [
    {
      id: record.event.id,
      tenantId: record.event.tenantId,
      eventType: record.event.eventType,
      payload: record.event.payload,
      createdAt: record.event.createdAt,
    },
  ]);
  assert.equal(db.updates.length, 2);
  assert.equal(db.updates[0].data.status, "PROCESSING");
  assert.deepEqual(db.updates[0].data.attemptCount, { increment: 1 });
  assert.equal(db.updates[1].data.status, "PUBLISHED");
  assert.ok(db.updates[1].data.publishedAt instanceof Date);
});

test("defers failed Kafka publication and schedules an exponential retry", async () => {
  const record = createOutboxRecord({ attemptCount: 2 });
  const db = createFakeDb(record);

  const result = await publishOutboxBatch({
    db,
    now: new Date("2026-11-26T10:00:00.000Z"),
    publish: async () => {
      throw new Error("Kafka broker unavailable");
    },
  });

  assert.deepEqual(result, { claimed: 1, published: 0, deferred: 1 });
  assert.equal(db.updates[1].data.status, "PENDING");
  assert.equal(db.updates[1].data.lastError, "Kafka broker unavailable");
  assert.equal(db.updates[1].data.nextAttemptAt.toISOString(), "2026-11-26T10:00:04.000Z");
});

test("does not publish an outbox record when another worker claims it", async () => {
  const db = createFakeDb(createOutboxRecord(), 0);
  let publishCalled = false;

  const result = await publishOutboxBatch({
    db,
    publish: async () => {
      publishCalled = true;
    },
  });

  assert.deepEqual(result, { claimed: 0, published: 0, deferred: 0 });
  assert.equal(publishCalled, false);
  assert.equal(db.updates.length, 1);
});

test("returns zero counts when no outbox events are due", async () => {
  const db = createFakeDb(null);

  const result = await publishOutboxBatch({
    db,
    publish: async () => {
      assert.fail("No event should be published");
    },
  });

  assert.deepEqual(result, { claimed: 0, published: 0, deferred: 0 });
  assert.equal(db.updates.length, 0);
});

test("caps retry delay at five minutes and bounds stored errors", async () => {
  const record = createOutboxRecord({ attemptCount: 9 });
  const db = createFakeDb(record);
  const now = new Date("2026-11-26T10:00:00.000Z");

  const result = await publishOutboxBatch({
    db,
    now,
    publish: async () => {
      throw new Error("x".repeat(1200));
    },
  });

  assert.deepEqual(result, { claimed: 1, published: 0, deferred: 1 });
  assert.equal(db.updates[1].data.lastError.length, 1000);
  assert.equal(db.updates[1].data.nextAttemptAt.toISOString(), "2026-11-26T10:05:00.000Z");
});

test("recovers a stale PROCESSING outbox claim", async () => {
  const record = createOutboxRecord({ status: "PROCESSING", attemptCount: 4 });
  const queries = [];
  const updates = [];
  const db = {
    eventOutbox: {
      async findMany(args) {
        queries.push(args);
        return [record];
      },
      async updateMany(args) {
        updates.push(args);
        return { count: 1 };
      },
    },
  };
  const now = new Date("2026-11-26T10:00:00.000Z");

  const result = await publishOutboxBatch({
    db,
    now,
    publish: async () => {},
  });

  assert.deepEqual(result, { claimed: 1, published: 1, deferred: 0 });
  assert.equal(
    queries[0].where.OR[1].updatedAt.lte.toISOString(),
    "2026-11-26T09:59:30.000Z",
  );
  assert.equal(
    updates[0].where.OR[1].updatedAt.lte.toISOString(),
    "2026-11-26T09:59:30.000Z",
  );
  assert.deepEqual(updates[0].data.attemptCount, { increment: 1 });
  assert.equal(updates[1].where.attemptCount, 5);
  assert.equal(updates[1].data.status, "PUBLISHED");
});
