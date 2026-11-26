-- Support stable cursor pagination and stale-work recovery queries.
CREATE INDEX "Event_tenantId_createdAt_id_idx"
ON "Event"("tenantId", "createdAt", "id");

DROP INDEX IF EXISTS "Event_tenantId_createdAt_idx";

CREATE INDEX "WebhookDelivery_eventId_createdAt_id_idx"
ON "WebhookDelivery"("eventId", "createdAt", "id");

CREATE INDEX "WebhookDelivery_status_updatedAt_idx"
ON "WebhookDelivery"("status", "updatedAt");

CREATE INDEX "EventOutbox_status_updatedAt_idx"
ON "EventOutbox"("status", "updatedAt");
