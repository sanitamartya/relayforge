/* global Buffer, fetch */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";

import { prisma } from "../src/db/prisma.js";
import { eventQueue } from "../src/queue/event-queue.js";
import { processDelivery } from "../src/workers/delivery-processor.js";

const sendLocalRequest = (url, options) => fetch(url, options);

async function createTestDelivery(url) {
  const tenant = await prisma.tenant.create({
    data: {
      name: `processor-test-${randomUUID()}`,
    },
  });

  const endpoint = await prisma.webhookEndpoint.create({
    data: {
      tenantId: tenant.id,
      url,
    },
  });

  const event = await prisma.event.create({
    data: {
      tenantId: tenant.id,
      eventType: "test.event",
      payload: {
        message: "hello",
      },
    },
  });

  const delivery = await prisma.webhookDelivery.create({
    data: {
      eventId: event.id,
      endpointId: endpoint.id,
    },
  });

  return {
    tenantId: tenant.id,
    eventId: event.id,
    deliveryId: delivery.id,
  };
}

test("delivery processor sends HTTP request and marks delivery DELIVERED", async () => {
  let receivedBody;
  let receivedDeliveryId;
  let receivedIdempotencyKey;

  const server = createServer(async (req, res) => {
    const chunks = [];

    for await (const chunk of req) {
      chunks.push(chunk);
    }

    receivedBody = JSON.parse(Buffer.concat(chunks).toString());
    receivedDeliveryId = req.headers["x-relayforge-delivery-id"];
    receivedIdempotencyKey = req.headers["idempotency-key"];

    res.writeHead(204);
    res.end();
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/webhook`;

  const testData = await createTestDelivery(url);

  try {
    const result = await processDelivery(testData.deliveryId, {
      sendRequest: sendLocalRequest,
    });

    assert.equal(result.delivered, true);
    assert.equal(result.statusCode, 204);

    assert.equal(receivedDeliveryId, testData.deliveryId);
    assert.equal(receivedIdempotencyKey, testData.deliveryId);
    assert.equal(receivedBody.type, "test.event");
    assert.deepEqual(receivedBody.data, {
      message: "hello",
    });

    const savedDelivery = await prisma.webhookDelivery.findUnique({
      where: { id: testData.deliveryId },
    });

    assert.equal(savedDelivery.status, "DELIVERED");
    assert.equal(savedDelivery.attemptCount, 1);
    assert.equal(savedDelivery.lastStatusCode, 204);
    assert.ok(savedDelivery.deliveredAt);
  } finally {
    await new Promise((resolve) => server.close(resolve));

    await prisma.tenant.deleteMany({
      where: { id: testData.tenantId },
    });
  }
});

test("delivery processor records an HTTP failure for retry", async () => {
  const server = createServer((req, res) => {
    res.writeHead(503);
    res.end("Service unavailable");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/webhook`;

  const testData = await createTestDelivery(url);

  try {
    await assert.rejects(
      processDelivery(testData.deliveryId, {
        sendRequest: sendLocalRequest,
      }),
      /Webhook endpoint returned HTTP 503/,
    );

    const savedDelivery = await prisma.webhookDelivery.findUnique({
      where: { id: testData.deliveryId },
    });

    assert.equal(savedDelivery.status, "PENDING");
    assert.equal(savedDelivery.attemptCount, 1);
    assert.equal(savedDelivery.lastStatusCode, 503);
    assert.ok(savedDelivery.lastError);
    assert.ok(savedDelivery.nextAttemptAt);
  } finally {
    await new Promise((resolve) => server.close(resolve));

    await prisma.tenant.deleteMany({
      where: { id: testData.tenantId },
    });
  }
});

test("concurrent processing sends only one request for a delivery", async () => {
  let requestCount = 0;

  const server = createServer((req, res) => {
    requestCount += 1;

    res.writeHead(200);
    res.end("accepted");
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/webhook`;

  const testData = await createTestDelivery(url);

  try {
    const results = await Promise.all([
      processDelivery(testData.deliveryId, { sendRequest: sendLocalRequest }),
      processDelivery(testData.deliveryId, { sendRequest: sendLocalRequest }),
    ]);

    assert.equal(requestCount, 1);

    assert.equal(results.filter((result) => result.delivered === true).length, 1);

    assert.equal(results.filter((result) => result.skipped === true).length, 1);

    const savedDelivery = await prisma.webhookDelivery.findUnique({
      where: { id: testData.deliveryId },
    });

    assert.equal(savedDelivery.status, "DELIVERED");
    assert.equal(savedDelivery.attemptCount, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));

    await prisma.tenant.deleteMany({
      where: { id: testData.tenantId },
    });
  }
});

test("delivery processor rejects private IP destinations", async () => {
  const testData = await createTestDelivery("http://127.0.0.1:8080/webhook");

  try {
    await assert.rejects(processDelivery(testData.deliveryId), /non-public IP address/);

    const savedDelivery = await prisma.webhookDelivery.findUnique({
      where: { id: testData.deliveryId },
    });

    assert.equal(savedDelivery.status, "PENDING");
    assert.equal(savedDelivery.attemptCount, 1);
    assert.match(savedDelivery.lastError, /non-public IP address/);
  } finally {
    await prisma.tenant.deleteMany({
      where: { id: testData.tenantId },
    });
  }
});

test("delivery processor retries safely when the request rejects with null", async () => {
  const testData = await createTestDelivery("https://example.com/webhook");

  try {
    await assert.rejects(
      processDelivery(testData.deliveryId, {
        sendRequest: async () => {
          throw null;
        },
      }),
      (error) => error === null,
    );

    const savedDelivery = await prisma.webhookDelivery.findUnique({
      where: { id: testData.deliveryId },
    });

    assert.equal(savedDelivery.status, "PENDING");
    assert.equal(savedDelivery.attemptCount, 1);
    assert.equal(savedDelivery.lastError, "null");
    assert.ok(savedDelivery.nextAttemptAt);
  } finally {
    await prisma.tenant.deleteMany({
      where: { id: testData.tenantId },
    });
  }
});

after(async () => {
  await eventQueue.close();
  await prisma.$disconnect();
});
