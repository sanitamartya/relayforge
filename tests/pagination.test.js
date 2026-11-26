import { Buffer } from "node:buffer";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

import { encodePaginationCursor, parsePagination } from "../src/utils/pagination.js";

test("pagination defaults to a bounded page size", () => {
  assert.deepEqual(parsePagination({}), {
    limit: 50,
    cursor: null,
    error: null,
  });
});

test("pagination accepts page sizes up to the configured maximum", () => {
  assert.equal(parsePagination({ limit: "100" }).limit, 100);
  assert.equal(parsePagination({ limit: "1" }).limit, 1);
});

test("pagination rejects invalid page sizes", () => {
  for (const limit of ["0", "101", "-1", "1.5", "abc", ["10"]]) {
    const result = parsePagination({ limit });
    assert.equal(result.error, "limit must be an integer between 1 and 100");
  }
});

test("pagination cursor round-trips a record ID and timestamp", () => {
  const record = {
    id: randomUUID(),
    createdAt: new Date("2026-11-26T10:30:00.000Z"),
  };
  const parsed = parsePagination({ cursor: encodePaginationCursor(record) });

  assert.equal(parsed.error, null);
  assert.equal(parsed.cursor.id, record.id);
  assert.equal(
    parsed.cursor.createdAt.toISOString(),
    record.createdAt.toISOString(),
  );
});

test("pagination rejects malformed cursors", () => {
  const invalidCursor = Buffer.from(JSON.stringify({ id: "bad", createdAt: "bad" })).toString(
    "base64url",
  );

  for (const cursor of ["invalid", "", "e30", invalidCursor]) {
    assert.equal(parsePagination({ cursor }).error, "cursor is invalid");
  }
});
