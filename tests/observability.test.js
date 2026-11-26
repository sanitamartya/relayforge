import test from "node:test";
import assert from "node:assert/strict";

import { recordBackgroundOperation, recordHttpRequest, renderMetrics } from "../src/observability/metrics.js";

test("HTTP metrics record request counts, server errors, and duration buckets", () => {
  recordHttpRequest({
    method: "GET",
    route: "/observability-test",
    statusCode: 503,
    durationMs: 30,
  });

  const metrics = renderMetrics();

  assert.match(metrics, /relayforge_http_requests_total\{method="GET",route="\/observability-test",status="503"\} 1/);
  assert.match(metrics, /relayforge_http_errors_total\{method="GET",route="\/observability-test",status="503"\} 1/);
  assert.match(metrics, /relayforge_http_request_duration_seconds_bucket\{method="GET",route="\/observability-test",le="0.05"\} 1/);
  assert.match(metrics, /relayforge_http_request_duration_seconds_count\{method="GET",route="\/observability-test"\} 1/);
});

test("Background operation metrics record component outcomes", () => {
  recordBackgroundOperation({
    component: "webhook_delivery",
    operation: "process",
    outcome: "failed",
  });

  assert.match(
    renderMetrics(),
    /relayforge_background_operations_total\{component="webhook_delivery",operation="process",outcome="failed"\} 1/,
  );
});
