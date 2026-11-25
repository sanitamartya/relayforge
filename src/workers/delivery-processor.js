/* global fetch, AbortSignal */
import { prisma } from "../db/prisma.js";

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ERROR_LENGTH = 1000;

export async function processDelivery(deliveryId) {
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

  // Avoid sending a delivery that has already completed.
  if (delivery.status === "DELIVERED" || delivery.status === "FAILED") {
    return {
      skipped: true,
      status: delivery.status,
    };
  }

  const attemptCount = delivery.attemptCount + 1;
  const lastAttemptAt = new Date();

  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: "PROCESSING",
      attemptCount,
      lastAttemptAt,
      nextAttemptAt: null,
    },
  });

  let statusCode = null;

  try {
    const response = await fetch(delivery.endpoint.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "RelayForge/1.0",
        "x-relayforge-event-id": delivery.event.id,
        "x-relayforge-delivery-id": delivery.id,
        "x-relayforge-event-type": delivery.event.eventType,
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

    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: "DELIVERED",
        deliveredAt: new Date(),
        lastStatusCode: statusCode,
        lastError: null,
        nextAttemptAt: null,
      },
    });

    return {
      delivered: true,
      statusCode,
      deliveryId,
    };
  } catch (error) {
    const message = String(error.message || error).slice(0, MAX_ERROR_LENGTH);

    // BullMQ will retry this job using its exponential backoff.
    const retryDelayMs = 1000 * 2 ** (attemptCount - 1);

    await prisma.webhookDelivery.update({
      where: { id: deliveryId },
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
