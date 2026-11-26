const HTTP_DURATION_BUCKETS = [
  0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10,
];

const httpRequests = new Map();
const httpDurations = new Map();
const backgroundOperations = new Map();
const httpErrors = new Map();

function escapeLabel(value) {
  return String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll('"', '\\\"');
}

function labels(values) {
  return Object.entries(values)
    .map(([key, value]) => `${key}="${escapeLabel(value)}"`)
    .join(",");
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

export function recordHttpRequest({ method, route, statusCode, durationMs }) {
  const requestLabels = { method, route, status: statusCode };
  const requestKey = labels(requestLabels);
  increment(httpRequests, requestKey);

  const durationKey = labels({ method, route });
  let duration = httpDurations.get(durationKey);

  if (!duration) {
    duration = {
      count: 0,
      sum: 0,
      buckets: HTTP_DURATION_BUCKETS.map(() => 0),
    };
    httpDurations.set(durationKey, duration);
  }

  const seconds = Math.max(0, durationMs / 1000);
  duration.count += 1;
  duration.sum += seconds;

  HTTP_DURATION_BUCKETS.forEach((upperBound, index) => {
    if (seconds <= upperBound) {
      duration.buckets[index] += 1;
    }
  });

  if (statusCode >= 500) {
    increment(httpErrors, labels({ method, route, status: statusCode }));
  }
}

export function recordBackgroundOperation({ component, operation, outcome }) {
  increment(backgroundOperations, labels({ component, operation, outcome }));
}

export function renderMetrics() {
  const lines = [
    "# HELP relayforge_http_requests_total Total HTTP requests handled.",
    "# TYPE relayforge_http_requests_total counter",
  ];

  for (const [labelSet, value] of httpRequests) {
    lines.push(`relayforge_http_requests_total{${labelSet}} ${value}`);
  }

  lines.push(
    "# HELP relayforge_http_request_duration_seconds HTTP request duration in seconds.",
    "# TYPE relayforge_http_request_duration_seconds histogram",
  );

  for (const [labelSet, duration] of httpDurations) {
    HTTP_DURATION_BUCKETS.forEach((upperBound, index) => {
      lines.push(
        `relayforge_http_request_duration_seconds_bucket{${labelSet},le="${upperBound}"} ${duration.buckets[index]}`,
      );
    });
    lines.push(
      `relayforge_http_request_duration_seconds_bucket{${labelSet},le="+Inf"} ${duration.count}`,
    );
    lines.push(`relayforge_http_request_duration_seconds_sum{${labelSet}} ${duration.sum}`);
    lines.push(
      `relayforge_http_request_duration_seconds_count{${labelSet}} ${duration.count}`,
    );
  }

  lines.push(
    "# HELP relayforge_http_errors_total Total HTTP responses with a server error status.",
    "# TYPE relayforge_http_errors_total counter",
  );

  for (const [labelSet, value] of httpErrors) {
    lines.push(`relayforge_http_errors_total{${labelSet}} ${value}`);
  }

  lines.push(
    "# HELP relayforge_background_operations_total Background operations by component, operation, and outcome.",
    "# TYPE relayforge_background_operations_total counter",
  );

  for (const [labelSet, value] of backgroundOperations) {
    lines.push(`relayforge_background_operations_total{${labelSet}} ${value}`);
  }

  lines.push(
    "# HELP relayforge_process_uptime_seconds Process uptime in seconds.",
    "# TYPE relayforge_process_uptime_seconds gauge",
    `relayforge_process_uptime_seconds ${process.uptime()}`,
    "# HELP relayforge_process_resident_memory_bytes Process resident memory in bytes.",
    "# TYPE relayforge_process_resident_memory_bytes gauge",
    `relayforge_process_resident_memory_bytes ${process.memoryUsage().rss}`,
  );

  return `${lines.join("\n")}\n`;
}
