# RelayForge — Phase 11 Performance Baseline

## Benchmark record

- Date: 2026-11-26
- Target: `GET http://127.0.0.1:3000/health`
- Duration: 15 seconds
- Concurrency: 10
- Completed requests: 39,831
- Throughput: 2,654.96 requests/second
- HTTP status: 39,831 responses with status 200
- Network errors: 0
- Non-success responses: 0
- Latency samples: 39,831 (below the benchmark's 100,000-sample cap)

## Latency

| Metric  |    Result |
| ------- | --------: |
| Minimum |   0.34 ms |
| Mean    |   3.73 ms |
| p50     |   2.52 ms |
| p90     |   7.28 ms |
| p95     |   9.08 ms |
| p99     |  13.81 ms |
| Maximum | 207.56 ms |

## Interpretation

The local liveness endpoint completed all 39,831 requests successfully during the 15-second run. The measured average throughput was approximately 2.65k requests/second at concurrency 10. Median latency was 2.52 ms and p99 latency was 13.81 ms. The maximum observed request latency (207.56 ms) was substantially higher than p99, indicating an isolated long-tail observation in this sample.

## Scope and limitations

This is a local, single-run HTTP liveness benchmark, not a production capacity claim. It measures only the `/health` route and does not exercise PostgreSQL-backed event ingestion, outbox publishing, Kafka consumption, Redis/BullMQ scheduling, or outbound webhook delivery. Results depend on the local machine, runtime, process state, and environment.

A meaningful comparative baseline requires the same machine, endpoint, duration, concurrency, and preferably repeated runs. Do not extrapolate this result directly to event throughput or concurrent webhook delivery capacity.

## Reproduction

From the RelayForge project root, with the API running:

```bash
npm run benchmark
```

Default benchmark settings: 15 seconds, concurrency 10, target `http://127.0.0.1:3000/health`.
