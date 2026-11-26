import "dotenv/config";
import { performance } from "node:perf_hooks";

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

const targetUrl = process.env.BENCHMARK_URL ?? "http://127.0.0.1:3000/health";
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

      latencies.push(performance.now() - requestStarted);
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
  latencies.length === 0
    ? null
    : Number((latencies.reduce((sum, latency) => sum + latency, 0) / latencies.length).toFixed(2));

console.log(
  JSON.stringify(
    {
      targetUrl,
      durationSeconds: Number(elapsedSeconds.toFixed(2)),
      concurrency,
      completedRequests: completed,
      networkErrors,
      nonSuccessResponses,
      requestsPerSecond: Number((completed / elapsedSeconds).toFixed(2)),
      statusCounts,
      latencyMs: {
        min: latencies.length ? Number(latencies[0].toFixed(2)) : null,
        mean: meanLatencyMs,
        p50: percentile(0.5),
        p90: percentile(0.9),
        p95: percentile(0.95),
        p99: percentile(0.99),
        max: latencies.length ? Number(latencies.at(-1).toFixed(2)) : null,
      },
    },
    null,
    2,
  ),
);
