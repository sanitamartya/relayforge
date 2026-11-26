/* global fetch, AbortSignal, URL */
import "dotenv/config";
import { performance } from "node:perf_hooks";

const MAX_LATENCY_SAMPLES = 100_000;

function readInteger(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const value = process.env[name];

  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }

  return parsed;
}

function getTargetUrl(value) {
  const url = new URL(value);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("BENCHMARK_URL must use http or https");
  }

  url.username = url.username ? "[REDACTED]" : "";
  url.password = url.password ? "[REDACTED]" : "";

  for (const key of url.searchParams.keys()) {
    if (/token|key|auth|secret|password|signature|credential/i.test(key)) {
      url.searchParams.set(key, "[REDACTED]");
    }
  }

  return url.toString();
}

const targetUrl = process.env.BENCHMARK_URL ?? "http://127.0.0.1:3000/health";
const safeTargetUrl = getTargetUrl(targetUrl);
const durationSeconds = readInteger("BENCHMARK_DURATION_SECONDS", 15, {
  min: 1,
  max: 300,
});
const concurrency = readInteger("BENCHMARK_CONCURRENCY", 10, {
  min: 1,
  max: 200,
});
const authorization = process.env.BENCHMARK_AUTHORIZATION;

const headers = authorization ? { authorization } : {};
const deadline = performance.now() + durationSeconds * 1000;
const startedAt = performance.now();
const latencies = [];
const statusCounts = {};
let completed = 0;
let networkErrors = 0;
let nonSuccessResponses = 0;
let latencySamplesSeen = 0;
let totalLatencyMs = 0;
let minLatencyMs = Infinity;
let maxLatencyMs = 0;

function recordLatency(latencyMs) {
  latencySamplesSeen += 1;
  totalLatencyMs += latencyMs;
  minLatencyMs = Math.min(minLatencyMs, latencyMs);
  maxLatencyMs = Math.max(maxLatencyMs, latencyMs);

  if (latencies.length < MAX_LATENCY_SAMPLES) {
    latencies.push(latencyMs);
    return;
  }

  // Reservoir sampling keeps a representative bounded sample for percentiles.
  const replacementIndex = Math.floor(Math.random() * latencySamplesSeen);

  if (replacementIndex < MAX_LATENCY_SAMPLES) {
    latencies[replacementIndex] = latencyMs;
  }
}

async function runWorker() {
  while (performance.now() < deadline) {
    const requestStarted = performance.now();

    try {
      const response = await fetch(targetUrl, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(10_000),
      });

      await response.arrayBuffer();

      recordLatency(performance.now() - requestStarted);
      completed += 1;
      statusCounts[response.status] = (statusCounts[response.status] ?? 0) + 1;

      if (!response.ok) {
        nonSuccessResponses += 1;
      }
    } catch {
      networkErrors += 1;
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => runWorker()));

const elapsedSeconds = (performance.now() - startedAt) / 1000;
latencies.sort((a, b) => a - b);

function percentile(value) {
  if (latencies.length === 0) {
    return null;
  }

  const index = Math.min(latencies.length - 1, Math.ceil(latencies.length * value) - 1);
  return Number(latencies[index].toFixed(2));
}

const meanLatencyMs =
  latencySamplesSeen === 0 ? null : Number((totalLatencyMs / latencySamplesSeen).toFixed(2));

console.log(
  JSON.stringify(
    {
      targetUrl: safeTargetUrl,
      durationSeconds: Number(elapsedSeconds.toFixed(2)),
      concurrency,
      completedRequests: completed,
      networkErrors,
      nonSuccessResponses,
      requestsPerSecond: Number((completed / elapsedSeconds).toFixed(2)),
      statusCounts,
      latencySampleCount: latencies.length,
      latencySampleLimit: MAX_LATENCY_SAMPLES,
      latencyMs: {
        min: latencySamplesSeen ? Number(minLatencyMs.toFixed(2)) : null,
        mean: meanLatencyMs,
        p50: percentile(0.5),
        p90: percentile(0.9),
        p95: percentile(0.95),
        p99: percentile(0.99),
        max: latencySamplesSeen ? Number(maxLatencyMs.toFixed(2)) : null,
      },
    },
    null,
    2,
  ),
);
