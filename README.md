# RelayForge

**A multi-tenant webhook and event delivery platform built with Node.js.**

RelayForge accepts application events, stores them in PostgreSQL with a transactional outbox record, retries Kafka publication asynchronously, and delivers webhook requests through Redis/BullMQ workers. It demonstrates backend engineering concepts including tenant isolation, authentication, durable records, asynchronous processing, retries, delivery history, and SSRF protection.

## Current implementation

- Tenant creation with one-time generated API keys
- SHA-256 API key hash storage and tenant-scoped bearer authentication
- Existing tenant API key rotation
- PostgreSQL persistence for tenants, events, endpoints, and delivery attempts
- Webhook endpoint registration and event ingestion
- Kafka event publishing and consumption through a transactional PostgreSQL outbox
- Retryable outbox publication with exponential backoff and stale-claim recovery
- Redis/BullMQ asynchronous delivery jobs
- Retry handling and recovery of stale processing records
- Delivery status/history endpoints
- Redis-backed per-tenant rate limiting
- Webhook URL validation and DNS/IP-based SSRF defenses
- HTTP response hardening, JSON body limit, and structured errors
- Unit and route tests, linting, formatting checks, and GitHub Actions CI

## Architecture

```text
Client
  |
  | Bearer API key
  v
Express API -------> PostgreSQL
                         | Event / Delivery / Outbox
                         v
                   Outbox publisher
                         |
                         | retryable publish
                         v
                     Kafka topic
                         |
                         v
Kafka consumer -------> Redis / BullMQ
                           |
                           v
                    Delivery worker
                           |
                           | Resolve + validate public DNS
                           | Pin validated address
                           v
                    Customer webhook
                           |
                           v
                    PostgreSQL delivery result
```

The API persists the event, its initial delivery records, and its outbox publication intent in one PostgreSQL transaction. A separate publisher in the Kafka worker reads the outbox and retries transient publication failures with exponential backoff. This avoids losing the publication intent when Kafka is unavailable after the API transaction commits. The publisher uses at-least-once delivery: a crash after Kafka accepts a message but before the outbox is marked published can cause a duplicate message. The Kafka worker keeps retrying the consumer connection after startup failures and continues polling the outbox during broker outages. The Kafka consumer finds durable delivery records and enqueues jobs using delivery IDs; the delivery processor atomically claims each database delivery so duplicate messages do not normally cause concurrent duplicate sends.

The delivery worker can retry failed jobs according to the queue's retry policy. The dispatcher also periodically recovers pending deliveries and stale processing records.

## Technology stack

| Layer                | Technology                     |
| -------------------- | ------------------------------ |
| Runtime              | Node.js 22+                    |
| API                  | Express 5                      |
| Database             | PostgreSQL 18                  |
| ORM                  | Prisma 7                       |
| Queue                | Redis 7, BullMQ                |
| Event streaming      | Apache Kafka 4.x               |
| Tests                | Node.js test runner, Supertest |
| Code quality         | ESLint, Prettier               |
| CI                   | GitHub Actions                 |
| Local infrastructure | Docker Compose                 |

## Requirements

- Node.js 22 or newer
- npm
- Docker Engine and Docker Compose
- Git

## Local setup

### 1. Clone and install

```bash
git clone https://github.com/sanitamartya/relayforge.git
cd relayforge
npm ci
```

### 2. Configure environment

```bash
cp .env.example .env
```

Set a strong local `POSTGRES_PASSWORD` and make sure `DATABASE_URL` uses the same credentials. The example configuration uses:

- PostgreSQL: `localhost:5434`
- Redis: `localhost:6380`
- Kafka: `localhost:9092`
- API: `localhost:3000`

Keep `.env` private; it is ignored by Git.

### 3. Start infrastructure

```bash
docker compose up -d
docker compose ps
```

Wait until PostgreSQL and Redis report healthy. Kafka may take a little longer to become ready.

### 4. Generate Prisma client and apply migrations

```bash
npx prisma generate
npx prisma migrate deploy
```

For local schema development only, use Prisma's migration development workflow rather than editing a migration already applied to a shared database.

### 5. Start the application processes

Run each process in its own terminal from the project root.

API:

```bash
npm start
```

Kafka event worker (consumer plus transactional outbox publisher):

```bash
npm run kafka:worker
```

Redis/BullMQ delivery worker and dispatcher:

```bash
npm run worker
```

Health check:

```bash
curl http://localhost:3000/health
```

## API overview

All successful responses use a `data` envelope. Errors use an `error` object with a machine-readable `code` and message.

| Method | Route                                     | Authentication    | Purpose                             |
| ------ | ----------------------------------------- | ----------------- | ----------------------------------- |
| GET    | `/health`                                 | No                | API liveness response               |
| GET    | `/ready`                                  | No                | PostgreSQL and Redis readiness      |
| GET    | `/metrics`                                | No                | Prometheus text-format metrics      |
| POST   | `/tenants`                                | No                | Create tenant; returns API key once |
| GET    | `/tenants/:id`                            | Tenant bearer key | Read tenant                         |
| POST   | `/tenants/:id/webhook-endpoints`          | Tenant bearer key | Register webhook endpoint           |
| POST   | `/tenants/:id/events`                     | Tenant bearer key | Persist and publish an event        |
| GET    | `/tenants/:id/events`                     | Tenant bearer key | Paginated tenant event history      |
| GET    | `/tenants/:id/events/:eventId/deliveries` | Tenant bearer key | Paginated delivery history          |

Event and delivery history endpoints use cursor pagination. The default page size is 50 records; `limit` accepts 1–100. When a response has more records, use its `pagination.nextCursor` value as the next request's `cursor` query parameter. Stable timestamp-and-ID ordering avoids duplicates when records share a timestamp.

Example:

```bash
curl -sS "http://localhost:3000/tenants/TENANT_ID/events?limit=25" \
  -H 'authorization: Bearer TENANT_API_KEY'
```

Tenant-scoped requests must include:

```http
Authorization: Bearer rf_live_<secret>
```

### Create a tenant

```bash
curl -sS http://localhost:3000/tenants \
  -H 'content-type: application/json' \
  -d '{"name":"Example Company"}'
```

Save the returned `apiKey` immediately. It is only returned at tenant creation or key rotation.

### Register a webhook endpoint

Replace `TENANT_ID` and `TENANT_API_KEY` with the values returned when creating your tenant. Use a publicly reachable HTTP(S) webhook URL. RelayForge intentionally rejects local and private network destinations.

```bash
curl -sS http://localhost:3000/tenants/TENANT_ID/webhook-endpoints \
  -H 'authorization: Bearer TENANT_API_KEY' \
  -H 'content-type: application/json' \
  -d '{"url":"https://your-public-webhook.example/relayforge"}'
```

### Publish an event

```bash
curl -sS http://localhost:3000/tenants/TENANT_ID/events \
  -H 'authorization: Bearer TENANT_API_KEY' \
  -H 'content-type: application/json' \
  -d '{"eventType":"order.created","payload":{"orderId":"ord_123","total":49.99}}'
```

The response includes the event ID and number of delivery records created for enabled endpoints.

### Inspect events and delivery attempts

```bash
curl -sS http://localhost:3000/tenants/TENANT_ID/events \
  -H 'authorization: Bearer TENANT_API_KEY'

curl -sS http://localhost:3000/tenants/TENANT_ID/events/EVENT_ID/deliveries \
  -H 'authorization: Bearer TENANT_API_KEY'
```

## API key management

Tenant API keys use the `rf_live_` prefix and high-entropy random bytes. RelayForge stores the SHA-256 hash rather than the plaintext key.

To rotate a tenant key:

```bash
npm run tenant:key:rotate -- <tenant-uuid>
```

Rotation invalidates the previous key. Copy the new key from the command output and store it securely. The key cannot be recovered from the database.

## Security controls

- Tenant-scoped bearer authentication
- Constant-time comparison of API key hashes
- Redis-backed per-tenant rate limiting
- Fail-closed behavior when the rate limiter is unavailable
- HTTP security headers and disabled Express fingerprint header
- `Cache-Control: no-store` for API responses
- JSON body size limit of 1 MB
- Webhook URL scheme and credential validation
- Rejection of local, reserved, private, and special-purpose IP addresses
- DNS resolution at delivery time; every returned address is validated
- HTTP requests use a validated DNS lookup callback to reduce DNS-rebinding risk
- Redirects are not automatically followed
- Webhook request header size limit

**Important:** This is a portfolio project and a work in progress, not a managed production service. Before production use, complete the remaining reliability, operational, infrastructure, and security review work.

## Observability

- `GET /health` is a liveness check and does not require dependencies to be available.
- `GET /ready` checks PostgreSQL and Redis and returns HTTP 503 when either dependency is unavailable.
- `GET /metrics` exposes HTTP request counts, server-error counts, request-duration histograms, background operation outcomes, process uptime, and resident memory in Prometheus text format.
- Every HTTP response includes an `X-Request-Id`. A valid client-provided ID is preserved; otherwise RelayForge generates a UUID. The same ID is included in the request-completion JSON log.
- API and worker logs are JSON lines with a timestamp, severity, service name, event message, and relevant context.
- Background delivery and Kafka outbox outcomes are recorded in logs and metrics.

Metrics are process-local and reset when the process restarts. In a deployed environment, restrict access to `/metrics` and operational endpoints to trusted monitoring and infrastructure.

See [the operations runbook](docs/operations-runbook.md) for diagnosis and routine checks.

## Development and verification

Run tests:

```bash
npm test
```

Run tests with Node's built-in coverage report:

```bash
npm run test:coverage
```

Run all quality checks:

```bash
npm run check
```

The quality check runs ESLint, Prettier validation, and the test suite with coverage. GitHub Actions runs the same check on pushes and pull requests.

## Project roadmap

RelayForge is being built in phases:

1. Project foundation
2. Backend application foundation
3. Database engineering
4. Multi-tenant API and product features
5. Asynchronous event processing
6. Reliable event delivery
7. Advanced distributed systems
8. Kafka and event streaming
9. Security and production hardening
10. Testing and quality engineering
11. Observability and operations
12. Performance and scalability
13. Cloud deployment and infrastructure
14. AI operations assistant
15. Portfolio and interview readiness

The roadmap reflects the full engineering journey; some later capabilities are planned and are not yet implemented.

## License

This repository currently uses the license value declared in `package.json`. Confirm and add the intended license file before distributing the project.
