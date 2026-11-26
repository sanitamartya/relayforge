import { test } from "node:test";
import assert from "node:assert/strict";

import { parseWorkerConcurrency } from "../src/workers/worker-config.js";

test("worker concurrency defaults to ten", () => {
  assert.equal(parseWorkerConcurrency(undefined), 10);
  assert.equal(parseWorkerConcurrency(""), 10);
});

test("worker concurrency accepts values from one through one hundred", () => {
  assert.equal(parseWorkerConcurrency("1"), 1);
  assert.equal(parseWorkerConcurrency("10"), 10);
  assert.equal(parseWorkerConcurrency("100"), 100);
});

test("worker concurrency rejects invalid and unsafe values", () => {
  for (const value of ["0", "101", "-1", "2.5", "abc"]) {
    assert.throws(
      () => parseWorkerConcurrency(value),
      /WEBHOOK_WORKER_CONCURRENCY must be an integer between 1 and 100/,
    );
  }
});
