/* global AbortSignal */
import { prisma } from "../db/prisma.js";
import { sendWebhookRequest } from "../security/webhook-url.js";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ERROR_LENGTH = 1000;

export async function processDelivery(deliveryId, { sendRequest = sendWebhookRequest } = {}) {
  const delivery = await prisma.webhookDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      event: true,
      endpoint: true,
    },
  });

  if (!delivery) {
    throw new Error(`Delivery ${deliveryId} was not found`);
  }

  // A completed or currently processing delivery should not be sent again.
  if (delivery.status !== "PENDING") {
    return {
      skipped: true,
      status: delivery.status,
    };
  }

  const lastAttemptAt = new Date();

  // Atomically claim the delivery.
  // Only one worker can change this exact PENDING row to PROCESSING.
  const claim = await prisma.webhookDelivery.updateMany({
    where: {
      id: deliveryId,
      status: "PENDING",
      attemptCount: delivery.attemptCount,
    },
    data: {
      status: "PROCESSING",
      attemptCount: {
        increment: 1,
      },
      lastAttemptAt,
      nextAttemptAt: null,
    },
  });

  if (claim.count !== 1) {
    return {
      skipped: true,
      status: "CLAIMED_BY_ANOTHER_WORKER",
    };
  }

  const attemptCount = delivery.attemptCount + 1;
  let statusCode = null;

  try {
    const response = await sendRequest(delivery.endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "RelayForge/1.0",
        "x-relayforge-event-id": delivery.event.id,
        "x-relayforge-delivery-id": delivery.id,
        "x-relayforge-event-type": delivery.event.eventType,

        // Stable across every retry of this delivery.
        "idempotency-key": delivery.id,
      },
      body: JSON.stringify({
        id: delivery.event.id,
        type: delivery.event.eventType,
        data: delivery.event.payload,
        createdAt: delivery.event.createdAt.toISOString(),
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    statusCode = response.status;

    if (!response.ok) {
      throw new Error(`Webhook endpoint returned HTTP ${response.status}`);
    }

    const completed = await prisma.webhookDelivery.updateMany({
      where: {
        id: deliveryId,
        status: "PROCESSING",
        attemptCount,
      },
      data: {
        status: "DELIVERED",
        deliveredAt: new Date(),
        lastStatusCode: statusCode,
        lastError: null,
        nextAttemptAt: null,
      },
    });

    if (completed.count !== 1) {
      throw new Error("Could not mark the delivery as DELIVERED");
    }

    return {
      delivered: true,
      statusCode,
      deliveryId,
    };
  } catch (error) {
    const message = String(error.message || error).slice(0, MAX_ERROR_LENGTH);

    // BullMQ uses exponential backoff between retry attempts.
    const retryDelayMs = 1000 * 2 ** (attemptCount - 1);

    await prisma.webhookDelivery.updateMany({
      where: {
        id: deliveryId,
        status: "PROCESSING",
        attemptCount,
      },
      data: {
        status: "PENDING",
        lastStatusCode: statusCode,
        lastError: message,
        nextAttemptAt: new Date(Date.now() + retryDelayMs),
      },
    });

    throw error;
  }
}
