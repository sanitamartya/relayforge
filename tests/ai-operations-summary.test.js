import { test, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";

import app from "../src/app.js";
import { createOllamaProvider } from "../src/ai/ollama-provider.js";
import { buildOperationsFacts, sanitizeFailureReason } from "../src/services/operations-summary.js";
import { eventQueue } from "../src/queue/event-queue.js";
import { prisma } from "../src/db/prisma.js";
import { disconnectKafkaProducer } from "../src/kafka/event-producer.js";

test("Ollama provider sends a non-streaming chat request and returns its text", async () => {
  let requestUrl;
  let requestBody;

  const provider = createOllamaProvider({
    baseUrl: "http://127.0.0.1:11434/",
    model: "test-model",
    fetchImpl: async (url, options) => {
      requestUrl = url;
      requestBody = JSON.parse(options.body);

      return {
        ok: true,
        json: async () => ({
          message: {
            content: "Three deliveries are pending.",
          },
        }),
      };
    },
  });

  const result = await provider.generate("Summarize these facts.");

  assert.equal(requestUrl, "http://127.0.0.1:11434/api/chat");
  assert.equal(requestBody.model, "test-model");
  assert.equal(requestBody.stream, false);
  assert.equal(result, "Three deliveries are pending.");
});

test("operations facts preserve the full recent failure count", () => {
  const facts = buildOperationsFacts({
    statusCounts: { FAILED: 7 },
    totalDeliveries: 7,
    recentFailureCount: 7,
    recentFailures: [],
    generatedAt: new Date("2026-01-01T00:00:00.000Z"),
  });

  assert.equal(facts.recentFailureCount, 7);
  assert.equal(facts.deliveryCounts.FAILED, 7);
});

test("failure reason sanitizer removes credentials and webhook URLs", () => {
  const sanitized = sanitizeFailureReason(
    "Failed https://customer.example/hook?token=secret Bearer abc123",
  );

  assert.equal(sanitized.includes("customer.example"), false);
  assert.equal(sanitized.includes("secret"), false);
  assert.equal(sanitized.includes("abc123"), false);
  assert.match(sanitized, /\[webhook URL\]/);
});

test("tenant operations summary is authenticated and tenant-scoped", async () => {
  const tenantResponse = await request(app).post("/tenants").send({
    name: "ai-operations-summary-test",
  });

  assert.equal(tenantResponse.status, 201);
  const tenantId = tenantResponse.body.data.id;
  const authorization = `***;

  const previousProvider = process.env.AI_PROVIDER;
  process.env.AI_PROVIDER = "test-unavailable";

  try {
    const unauthenticated = await request(app).get(`/tenants/${tenantId}/ai/operations-summary`);
    assert.equal(unauthenticated.status, 401);

    const event = await prisma.event.create({
      data: {
        tenantId,
        eventType: "test.delivery.failed",
        payload: {
          test: true,
        },
      },
    });
    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        tenantId,
        url: "https://example.com/webhook",
      },
    });
    await prisma.webhookDelivery.create({
      data: {
        eventId: event.id,
        endpointId: endpoint.id,
        status: "FAILED",
        attemptCount: 3,
        lastStatusCode: 503,
        lastError: "Webhook endpoint returned HTTP 503",
      },
    });

    const response = await request(app)
      .get(`/tenants/${tenantId}/ai/operations-summary`)
      .set("authorization", authorization);

    assert.equal(response.status, 200);
    assert.equal(response.body.data.facts.totalDeliveries, 1);
    assert.equal(response.body.data.facts.deliveryCounts.FAILED, 1);
    assert.equal(response.body.data.facts.recentFailureCount, 1);
    assert.equal(response.body.data.facts.recentFailures[0].attemptCount, 3);
    assert.equal(response.body.data.facts.recentFailures[0].lastStatusCode, 503);
    assert.equal("endpointUrl" in response.body.data.facts.recentFailures[0], false);
    assert.match(response.body.data.assistant.text, /1 webhook deliveries|1 delivery/);

    const missingQuestion = await request(app)
      .post(`/tenants/${tenantId}/ai/ask`)
      .set("authorization", authorization)
      .send({ question: "   " });
    assert.equal(missingQuestion.status, 400);

    const oversizedQuestion = await request(app)
      .post(`/tenants/${tenantId}/ai/ask`)
      .set("authorization", authorization)
      .send({ question: "x".repeat(501) });
    assert.equal(oversizedQuestion.status, 400);

    const answer = await request(app)
      .post(`/tenants/${tenantId}/ai/ask`)
      .set("authorization", authorization)
      .send({ question: "Why did my delivery fail?" });

    assert.equal(answer.status, 200);
    assert.equal(answer.body.data.question, "Why did my delivery fail?");
    assert.equal(answer.body.data.facts.deliveryCounts.FAILED, 1);
    assert.equal(answer.body.data.assistant.status, "unavailable");
  } finally {
    if (previousProvider === undefined) {
      delete process.env.AI_PROVIDER;
    } else {
      process.env.AI_PROVIDER = previousProvider;
    }
    await prisma.tenant.deleteMany({
      where: {
        id: tenantId,
      },
    });
  }
});

after(async () => {
  await disconnectKafkaProducer();
  await eventQueue.close();
  await prisma.$disconnect();
});
