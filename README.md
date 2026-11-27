# RelayForge

**A multi-tenant webhook and event delivery platform built with Node.js, PostgreSQL, Kafka, Redis, and BullMQ.**

RelayForge is a backend engineering portfolio project that accepts application events and delivers them to registered customer webhooks through an asynchronous, retryable event-processing pipeline. It demonstrates durable event handling, tenant isolation, distributed processing, operational observability, and security-conscious webhook delivery.

> **Project status:** Core implementation through the AI Operations Assistant (Phase 13) is complete and validated locally. Cloud deployment and production-environment validation are planned next. RelayForge is a portfolio project, not a managed production service.

## Highlights

- Multi-tenant API with tenant-scoped bearer API keys
- One-time API key display, hashed key storage, and key rotation
- PostgreSQL persistence for tenants, events, webhook endpoints, delivery records, and outbox records
- Transactional outbox with retryable Kafka publication
- Kafka event streaming and consumer processing
- Redis and BullMQ background webhook delivery
- Delivery retries and stale-work recovery
- Per-tenant rate limiting
- Delivery history and cursor-based pagination
- Webhook URL validation and SSRF defenses
- Prometheus metrics and structured JSON logs
- Read-only AI Operations Assistant powered by local Ollama
- Automated tests, linting, formatting checks, and GitHub Actions CI

## Architecture

```text
Client
  | Tenant bearer API key
  v
Express API -------> PostgreSQL
                         | Event + Delivery + Outbox
                         v
                  Outbox publisher
                         |
                         v
                    Kafka topic
                         |
                         v
Kafka consumer -------> Redis / BullMQ
                           |
                           v
                    Delivery worker
                           |
                           | Validate URL and resolved IPs
                           v
                    Customer webhook
                           |
                           v
                    PostgreSQL result
```

The API writes the event, its initial delivery records, and the outbox intent in one PostgreSQL transaction. The outbox publisher retries Kafka publication with exponential backoff. Kafka consumers enqueue durable delivery IDs, and workers atomically claim delivery records before sending webhooks.

The outbox and Kafka flow is **at-least-once**: a crash after Kafka accepts a message but before the outbox record is marked published can result in a duplicate message. Delivery claiming and durable records help prevent concurrent duplicate sends.

## Technology stack

| Layer | Technology |
| --- | --- |
| Runtime | Node.js 22+ |
| API | Express 5 |
| Database | PostgreSQL 18 |
| ORM | Prisma 7 |
| Queue | Redis 7, BullMQ |
| Event streaming | Apache Kafka 4.x |
| Tests | Node.js test runner, Supertest |
| Quality | ESLint, Prettier |
| CI | GitHub Actions |
| Local infrastructure | Docker Compose |

## Getting started

### Requirements

- Node.js 22 or newer
- npm
- Docker Engine and Docker Compose
- Git

### 1. Clone the repository

```bash
git clone https://github.com/sanitamartya/relayforge.git
cd relayforge
npm ci
```

### 2. Configure environment variables

```bash
cp .env.example .env
```

Set a strong local `POSTGRES_PASSWORD` and ensure `DATABASE_URL` uses the same credentials. Keep environment files private; they are ignored by Git.

The local development ports are:

| Service | Host port |
| --- | ---: |
| API | 3000 |
| PostgreSQL | 5434 |
| Redis | 6380 |
| Kafka | 9092 |

### 3. Start infrastructure

```bash
docker compose up -d db redis kafka
docker compose ps
```

Wait for PostgreSQL and Redis to become healthy. Kafka may take longer to start.

### 4. Prepare the database

```bash
npx prisma generate
npx prisma migrate deploy
```

### 5. Run the application processes

Start each process in a separate terminal from the project root.

API:

```bash
npm start
```

Kafka consumer and outbox publisher:

```bash
npm run kafka:worker
```

BullMQ delivery worker and dispatcher:

```bash
npm run worker
```

Check the API:

```bash
curl http://localhost:3000/health
```

## API overview

Successful responses use a `data` envelope. Errors use an `error` object containing a machine-readable code and message.

| Method | Route | Authentication | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | None | Liveness check |
| GET | `/ready` | None | PostgreSQL and Redis readiness |
| GET | `/metrics` | None | Prometheus metrics |
| POST | `/tenants` | None | Create tenant; returns API key once |
| GET | `/tenants/:id` | Tenant bearer key | Read tenant |
| GET | `/tenants/:id/ai/operations-summary` | Tenant bearer key | Read-only AI operations summary |
| POST | `/tenants/:id/ai/ask` | Tenant bearer key | Ask a read-only operations question |
| POST | `/tenants/:id/webhook-endpoints` | Tenant bearer key | Register webhook endpoint |
| POST | `/tenants/:id/events` | Tenant bearer key | Create event and delivery records |
| GET | `/tenants/:id/events` | Tenant bearer key | Paginated event history |
| GET | `/tenants/:id/events/:eventId/deliveries` | Tenant bearer key | Paginated delivery history |

Tenant-scoped requests use:

```http
Authorization: Bearer rf_live_<tenant-api-key>
```

### Create a tenant

```bash
curl -sS http://localhost:3000/tenants \
  -H 'content-type: application/json' \
  -d '{"name":"Example Company"}'
```

Save the returned `apiKey` immediately. It is only shown when the key is created or rotated.

### Register a webhook endpoint

Use a publicly reachable HTTP(S) webhook URL. RelayForge rejects local and private network destinations.

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

### Inspect event and delivery history

```bash
curl -sS http://localhost:3000/tenants/TENANT_ID/events \
  -H 'authorization: Bearer TENANT_API_KEY'

curl -sS http://localhost:3000/tenants/TENANT_ID/events/EVENT_ID/deliveries \
  -H 'authorization: Bearer TENANT_API_KEY'
```

History endpoints use cursor pagination. The default page size is 50; `limit` accepts 1–100. Use `pagination.nextCursor` as the next request's `cursor` parameter.

## AI Operations Assistant

RelayForge includes a read-only, tenant-scoped assistant that answers operational questions using database-grounded delivery facts.

The default provider is local [Ollama](https://ollama.com/); no paid model API is required. To enable generated narratives:

1. Install and start Ollama.
2. Download the default model:

   ```bash
   ollama pull qwen2.5:3b
   ```

3. Configure the private environment file:

   ```dotenv
   AI_PROVIDER=ollama
   OLLAMA_BASE_URL=http://127.0.0.1:11434
   OLLAMA_MODEL=qwen2.5:3b
   AI_OPERATIONS_TIMEOUT_MS=30000
   ```

Example operations summary:

```bash
curl http://localhost:3000/tenants/TENANT_ID/ai/operations-summary \
  -H "Authorization: Bearer TENANT_API_KEY"
```

Ask an operational question:

```bash
curl -X POST http://localhost:3000/tenants/TENANT_ID/ai/ask \
  -H "Authorization: Bearer TENANT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"question":"How many deliveries failed recently?"}'
```

If the model is unavailable or times out, RelayForge returns the operational facts with a deterministic fallback. Database facts are authoritative; model output is narrative only. The assistant is read-only and does not execute operations.

When the API runs in Docker and Ollama runs on the host, configure `OLLAMA_BASE_URL` in the private container environment file to `http://host.docker.internal:11434` (the Compose configuration maps the host gateway). In a cloud environment, use a private network address for the model host; do not expose Ollama publicly.

## Security

- Tenant-scoped bearer authentication and tenant isolation
- High-entropy API keys; SHA-256 hash storage
- Constant-time API key hash comparison
- Redis-backed per-tenant rate limiting with fail-closed behavior
- HTTP security headers and disabled Express fingerprint header
- `Cache-Control: no-store` for API responses
- 1 MB JSON request body limit
- Webhook URL scheme and credential validation
- Rejection of private, reserved, local, and special-purpose IP addresses
- DNS resolution and address validation at delivery time
- Validated DNS lookup callback to reduce DNS-rebinding risk
- Redirects are not automatically followed
- Webhook request header size limit

## Observability

- `GET /health`: liveness check
- `GET /ready`: dependency readiness; returns HTTP 503 if PostgreSQL or Redis is unavailable
- `GET /metrics`: Prometheus text-format metrics, including HTTP and background-operation metrics
- Request IDs returned in `X-Request-Id` and included in request-completion logs
- Structured JSON logs for API and worker processes

Metrics are process-local and reset on restart. Restrict metrics and operational endpoints to trusted monitoring systems in deployed environments.

See the [operations runbook](docs/operations-runbook.md) for routine checks and troubleshooting.

## Development and verification

Run the test suite:

```bash
npm test
```

Run coverage:

```bash
npm run test:coverage
```

Run all quality checks:

```bash
npm run check
```

The `check` script runs ESLint, Prettier validation, and tests with coverage. GitHub Actions runs the project checks on pushes and pull requests.

## Roadmap

- [x] Core multi-tenant webhook and event delivery platform
- [x] Transactional outbox and Kafka event processing
- [x] Background delivery, retries, and recovery
- [x] Security hardening and observability
- [x] Docker-based local deployment configuration
- [x] Local AI Operations Assistant (Phase 13)
- [ ] Cloud deployment and production-environment validation
- [ ] Portfolio and interview readiness (Phase 14)

## License

The project currently declares the **ISC** license in `package.json`.
