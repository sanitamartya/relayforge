const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parsePagination(query) {
  let limit = DEFAULT_PAGE_SIZE;

  if (query.limit !== undefined) {
    if (typeof query.limit !== "string" || !/^\d+$/.test(query.limit)) {
      return { error: "limit must be an integer between 1 and 100" };
    }

    limit = Number(query.limit);

    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
      return { error: "limit must be an integer between 1 and 100" };
    }
  }

  let cursor = null;

  if (query.cursor !== undefined) {
    if (typeof query.cursor !== "string" || query.cursor.length > 512) {
      return { error: "cursor is invalid" };
    }

    try {
      const decoded = Buffer.from(query.cursor, "base64url").toString("utf8");
      const value = JSON.parse(decoded);
      const createdAt = new Date(value.createdAt);

      if (
        !value ||
        typeof value !== "object" ||
        !UUID_PATTERN.test(value.id) ||
        typeof value.createdAt !== "string" ||
        Number.isNaN(createdAt.getTime())
      ) {
        return { error: "cursor is invalid" };
      }

      cursor = {
        id: value.id,
        createdAt,
      };
    } catch {
      return { error: "cursor is invalid" };
    }
  }

  return { limit, cursor, error: null };
}

export function encodePaginationCursor(record) {
  return Buffer.from(
    JSON.stringify({
      id: record.id,
      createdAt: record.createdAt.toISOString(),
    }),
  ).toString("base64url");
}
