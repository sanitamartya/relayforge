# RelayForge

**A production-grade distributed webhook and event delivery platform.**

RelayForge helps SaaS platforms reliably deliver application events to customer-defined webhook endpoints without building and maintaining their own event delivery infrastructure.

## The Problem

When a SaaS application needs to notify external systems about events, it must handle:

- Temporary endpoint failures
- Retries and exponential backoff
- Duplicate event delivery
- Durable event storage
- Asynchronous processing
- Delivery history and debugging
- Dead-letter handling and event replay
- Rate limits and traffic spikes

RelayForge is designed to provide these capabilities through a reliable, developer-friendly event delivery platform.

## Core Features

Planned capabilities include:

- Event ingestion API
- Multi-tenant architecture
- Durable event persistence
- Asynchronous event processing
- Webhook delivery workers
- Retry policies and exponential backoff
- Idempotency
- Delivery logs and status tracking
- Dead-letter queue and event replay
- Rate limiting and backpressure
- Distributed worker scaling
- Observability and operational metrics
- Cloud deployment
- Optional read-only AI operations assistant

## Technology Stack

| Area             | Technology                         |
| ---------------- | ---------------------------------- |
| Language         | JavaScript (ES Modules)            |
| Runtime          | Node.js                            |
| API              | Express.js                         |
| Database         | PostgreSQL                         |
| ORM              | Prisma                             |
| Queue            | Redis and BullMQ                   |
| Event Streaming  | Apache Kafka                       |
| Testing          | Node.js test runner and Supertest  |
| Containerization | Docker                             |
| CI/CD            | GitHub Actions                     |
| Logging          | Pino                               |
| Observability    | OpenTelemetry, Prometheus, Grafana |
| Infrastructure   | AWS and Terraform                  |
| Orchestration    | Kubernetes and Helm                |

The stack will be introduced incrementally as the project develops.

## Architecture Overview

At a high level, RelayForge will:

1. Accept events through an authenticated API.
2. Validate and persist incoming events.
3. Queue eligible events for asynchronous processing.
4. Deliver events to configured webhook endpoints.
5. Retry failed deliveries according to policy.
6. Record delivery attempts and outcomes.
7. Support inspection, recovery, and replay of failed events.

The architecture will evolve toward durable, horizontally scalable event processing.

## Project Status

RelayForge is under active development. The current implementation includes tenant-scoped API keys, event ingestion, Kafka event streaming, durable webhook deliveries, retries, and delivery history.

The current development stage is **Security & Production Hardening**.

## Tenant API Authentication

Creating a tenant with `POST /tenants` returns a generated API key once. Store it securely; RelayForge stores only its SHA-256 hash and does not return the key from later tenant reads.

Send the key as a bearer token when accessing tenant-scoped routes:

```http
Authorization: Bearer rf_live_your_api_key
```

Existing tenants created before API key support have no key until it is rotated. Generate a new key for a tenant with:

```bash
npm run tenant:key:rotate -- <tenant-uuid>
```

Copy the printed key immediately and store it in a secret manager or local environment file. The old key is replaced and cannot be retrieved afterward.

## HTTP API Hardening

The API adds baseline response security headers, disables the Express identifying header, and marks responses as non-cacheable to help protect sensitive API responses such as the one-time tenant API key.

JSON request bodies are limited to 1 MB. Oversized requests receive HTTP 413, and malformed JSON receives a structured HTTP 400 response.

## Webhook SSRF Protection

Webhook URLs must use HTTP or HTTPS, cannot contain credentials, and cannot target local or reserved hostnames or non-public IP addresses.

Before each delivery, RelayForge resolves the webhook hostname and rejects the destination if any resolved address is non-public. The delivery request uses the validated address for its connection, reducing DNS-rebinding risk. HTTP redirects are not followed automatically, so a public webhook cannot redirect the worker to an internal address.

## Getting Started

### Requirements

- Node.js 22 or later
- npm
- Git

### Setup

Clone the repository and install dependencies:

```bash
git clone <repository-url>
cd relayforge
npm install
```
