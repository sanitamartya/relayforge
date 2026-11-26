# RelayForge Operations Runbook

This runbook covers local verification and first-line diagnosis for the RelayForge API, PostgreSQL, Redis/BullMQ, Kafka, and background workers.

## Start and verify the local stack

From the repository root:

```bash
docker compose up -d
docker compose ps
```

Wait for PostgreSQL and Redis to report healthy. Kafka can take longer to become ready.

Apply the database migrations and generate the Prisma client:

```bash
npx prisma generate
npx prisma migrate deploy
```

Start the API and workers in separate terminals:

```bash
npm start
npm run worker
npm run kafka:worker
```

Run the quality gate before committing:

```bash
npm run check
```

## Health and readiness

Liveness:

```bash
curl -i http://localhost:3000/health
```

A successful liveness response means the API process is responding. It does not prove dependencies are available.

Readiness:

```bash
curl -i http://localhost:3000/ready
```

Readiness checks PostgreSQL and Redis. HTTP 200 with both checks set to `ok` means the API's required synchronous dependencies are reachable. HTTP 503 means at least one required dependency failed its check.

Kafka is intentionally not part of API readiness. Event creation persists a transactional outbox record in PostgreSQL, so Kafka outages can be buffered and retried asynchronously. Verify the Kafka worker and outbox metrics when Kafka is unavailable.

## Metrics

Fetch the current process metrics:

```bash
curl -sS http://localhost:3000/metrics
```

Available metrics include:

- `relayforge_http_requests_total`: HTTP requests grouped by method, route template, and status.
- `relayforge_http_errors_total`: HTTP responses with status 500 or higher.
- `relayforge_http_request_duration_seconds`: request duration histogram, sum, and count.
- `relayforge_background_operations_total`: background outcomes for webhook delivery, dispatching, and Kafka outbox operations.
- `relayforge_process_uptime_seconds` and `relayforge_process_resident_memory_bytes`: process health indicators.

Metrics are held in memory and reset on restart. Use a persistent monitoring backend for production history.

## Request tracing through logs

Each HTTP response includes `X-Request-Id`. A valid caller-provided value is preserved; otherwise the API generates a UUID.

For one request, copy the response header and search the API's JSON-line logs for its `requestId`. Logs include the event message, timestamp, severity, service, and relevant request or job context.

Do not log or share API keys, authorization headers, database credentials, or webhook secrets.

## Common failure diagnosis

### API readiness returns 503

1. Check `curl -i http://localhost:3000/ready` and identify which dependency check reports `error`.
2. Check container status with `docker compose ps`.
3. Inspect PostgreSQL and Redis logs:

```bash
docker compose logs --tail=100 db redis
```

4. Confirm `.env` contains the expected `DATABASE_URL` and `REDIS_URL` and that the local ports match the Compose configuration.
5. Apply pending migrations with `npx prisma migrate deploy` if PostgreSQL is reachable but the schema is behind.

### Webhook deliveries are pending or failing

1. Confirm the Redis container is healthy.
2. Confirm the delivery worker (`npm run worker`) is running.
3. Inspect the delivery history endpoint for status, attempt count, next attempt, last HTTP status, and last error.
4. Check `relayforge_background_operations_total` for dispatcher and delivery outcomes.
5. Remember that failed webhook attempts are retried by BullMQ; a terminal failure is recorded as `FAILED`.

### Kafka events are delayed

1. Confirm the Kafka container is running with `docker compose ps`.
2. Confirm `npm run kafka:worker` is running.
3. Inspect worker JSON logs for consumer connection retries or outbox publication failures.
4. Check the `kafka_outbox` background metrics. The PostgreSQL outbox retains publication intent and retries transient failures.

### Quality checks fail

Run `npm run check` and address the reported ESLint, Prettier, or test failure. The GitHub Actions CI workflow runs the same quality command after installing dependencies and applying migrations.

## Performance checks

The event and delivery-history API endpoints use cursor pagination with a default page size of 50 and a maximum of 100. Use the returned `pagination.nextCursor` to fetch the next page rather than requesting an unbounded result set.

The delivery worker supports bounded concurrency through `WEBHOOK_WORKER_CONCURRENCY` (1–100, default 10). Increase it gradually while observing webhook endpoint response times, Redis load, and database connection pressure. Do not set it to an arbitrarily high value.

A dependency-free GET benchmark is included:

```bash
npm run benchmark
```

By default, it measures `GET /health` for 15 seconds with 10 concurrent requests. It reports requests per second, status counts, network errors, and latency percentiles.

To benchmark a tenant's event-history query, set a URL and the tenant's bearer token in the current shell:

```bash
BENCHMARK_URL="http://127.0.0.1:3000/tenants/TENANT_ID/events?limit=50" \
BENCHMARK_AUTHORIZATION="Bearer TENANT_API_KEY" \
BENCHMARK_DURATION_SECONDS=30 \
BENCHMARK_CONCURRENCY=10 \
npm run benchmark
```

The tenant rate limiter is enabled on this endpoint. For a local benchmark only, temporarily raise `TENANT_RATE_LIMIT_MAX` in your private `.env` and restart the API so the rate limit does not dominate the results. Restore the original value after benchmarking. Never commit the API key or private environment file.

Compare runs using the same target URL, duration, concurrency, data volume, and machine. Run the benchmark before and after a performance change; report throughput and p50/p95/p99 latency together. This simple benchmark is a repeatable local comparison, not a production load test.

## Operational endpoint access

The local project exposes `/ready` and `/metrics` without authentication for development and monitoring. In a deployed environment, restrict these endpoints to trusted infrastructure or monitoring systems at the network or ingress layer.
