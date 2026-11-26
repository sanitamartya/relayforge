const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function getValidEventId(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    return null;
  }

  const eventId = event.id ?? event.eventId;

  return typeof eventId === "string" && UUID_PATTERN.test(eventId) ? eventId : null;
}
