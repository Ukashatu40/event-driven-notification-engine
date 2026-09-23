# BE-6B — Event-Driven Notification Engine with Multi-Channel Delivery

[![CI](https://github.com/Ukashatu40/BE-6B-NotificationEngine-UkashatuAbdullahi/actions/workflows/ci.yml/badge.svg)](https://github.com/Ukashatu40/BE-6B-NotificationEngine-UkashatuAbdullahi/actions)

A production-grade, event-driven notification platform designed for financial services. The system processes more than 25 financial event types and delivers notifications across SMS, Email, Push, WhatsApp, and In-App channels while enforcing TRAI DND compliance, frequency capping, quiet-hour restrictions, intelligent failover, and real-time operational analytics.

**Live demo:** _add your deployed URLs here once you've followed [DEPLOYMENT-CLOUD.md](DEPLOYMENT-CLOUD.md)._ It runs on free tiers
(Render backend, Vercel frontend), so the very first request after a quiet spell can take up to a minute to wake up — a well-known
free-tier trade-off, not a bug.

---

## Overview

The Notification Engine is built around an event-driven architecture that guarantees reliable, scalable, and observable message delivery for mission-critical financial communications.

### Core Capabilities

- Multi-channel notification delivery
- Event-driven processing pipeline
- Real-time analytics and monitoring
- TRAI DND compliance enforcement
- User preference management
- Frequency capping and anti-spam controls
- Quiet-hours enforcement
- Dead Letter Queue (DLQ) handling
- Circuit breaker-based provider failover
- Multi-language template support
- Full audit trail and observability

---

## Architecture

```text
┌──────────────────┐
│ Event Producers  │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│   API Gateway    │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│      Kafka       │
│ Event Streaming  │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Processing Layer │
│ • Validation     │
│ • Enrichment     │
│ • Routing        │
│ • Compliance     │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│    RabbitMQ      │
│ Delivery Queues  │
└────────┬─────────┘
         │
         ▼
┌──────────────────┐
│ Delivery Workers │
└──────────────────┘

Supporting Infrastructure
────────────────────────────────────
Redis        → Cache, Deduplication, Rate Limits
PostgreSQL   → State, Audit Logs, Analytics
Prometheus   → Metrics Collection
Grafana      → Dashboards & Monitoring
```

### Technology Stack

| Layer            | Technology           |
| ---------------- | -------------------- |
| Framework        | NestJS + Fastify     |
| Language         | TypeScript           |
| Database         | PostgreSQL 15        |
| Cache            | Redis 7              |
| Event Streaming  | Apache Kafka         |
| Message Queue    | RabbitMQ 3.12        |
| ORM              | Prisma               |
| Containerization | Docker               |
| Monitoring       | Prometheus + Grafana |

---

## Quick Start

### Prerequisites

- Node.js 20 LTS
- Docker
- Docker Compose
- npm

### 1. Clone the Repository

```bash
git clone https://github.com/Ukashatu40/BE-6B-NotificationEngine-UkashatuAbdullahi.git

cd BE-6B-NotificationEngine-UkashatuAbdullahi

npm install --legacy-peer-deps
```

> Note: several dependencies (including `@nestjs/websockets`, `@nestjs/platform-socket.io`, and `socket.io`, added for the real-time dashboard bonus feature) require `--legacy-peer-deps` due to peer dependency conflicts with the NestJS 10.x toolchain used in this project.

### 2. Configure Environment Variables

```bash
cp .env.example .env
```

Update the following variables:

```env
DB_PASSWORD=
REDIS_PASSWORD=
RABBITMQ_PASSWORD=
JWT_SECRET=
JWT_REFRESH_SECRET=
WEBHOOK_SIGNATURE_SECRET=
```

> Security Note: Use a minimum of 32 characters for all cryptographic secrets.

### 3. Start Infrastructure Services

```bash
docker compose up postgres redis zookeeper kafka rabbitmq -d
```

### 4. Run Database Migrations

```bash
npx prisma migrate dev
npx prisma generate
npm run prisma:seed
```

### 5. Start the Application

```bash
npm run start:dev
```

### 6. Start the Complete Stack

```bash
docker compose up -d
```

---

## Local Development URLs

| Service               | URL                            |
| --------------------- | ------------------------------ |
| API                   | http://localhost:3000          |
| Swagger Documentation | http://localhost:3000/api-docs |
| Metrics Endpoint      | http://localhost:3000/metrics  |
| Health Check          | http://localhost:3000/health   |

---

## API Reference

### Event Management

| Method | Endpoint         | Description              |
| ------ | ---------------- | ------------------------ |
| POST   | `/api/v1/events` | Ingest a financial event |

### Notifications

| Method | Endpoint                          | Description                              |
| ------ | --------------------------------- | ---------------------------------------- |
| GET    | `/api/v1/notifications/:id`       | Retrieve notification status and history |
| GET    | `/api/v1/users/:id/notifications` | Retrieve paginated user notifications    |

### User Preferences

| Method | Endpoint                        | Description                     |
| ------ | ------------------------------- | ------------------------------- |
| GET    | `/api/v1/users/:id/preferences` | Get notification preferences    |
| PUT    | `/api/v1/users/:id/preferences` | Update notification preferences |

### Analytics

| Method | Endpoint                                | Description                   |
| ------ | --------------------------------------- | ----------------------------- |
| GET    | `/api/v1/analytics/delivery-rates`      | Delivery success metrics      |
| GET    | `/api/v1/analytics/channel-performance` | Channel performance analytics |
| GET    | `/api/v1/analytics/opt-out-trends`      | User opt-out trends           |
| GET    | `/api/v1/analytics/realtime`            | Real-time operational metrics |

### Dead Letter Queue

| Method | Endpoint                  | Description         |
| ------ | ------------------------- | ------------------- |
| GET    | `/api/v1/dlq`             | List DLQ entries    |
| PATCH  | `/api/v1/dlq/:id/resolve` | Resolve a DLQ entry |

### Platform Health

| Method | Endpoint   | Description        |
| ------ | ---------- | ------------------ |
| GET    | `/health`  | Health endpoint    |
| GET    | `/ready`   | Readiness probe    |
| GET    | `/live`    | Liveness probe     |
| GET    | `/metrics` | Prometheus metrics |

---

## Supported Financial Event Types

### Transaction Events (TXNX)

| Event           | Priority |
| --------------- | -------- |
| Buy Executed    | High     |
| Sell Executed   | High     |
| Order Rejected  | High     |
| Dividend Credit | High     |
| Funds Deposit   | High     |

### Risk & Margin Events (RISK)

| Event                | Priority |
| -------------------- | -------- |
| Margin Call Warning  | Critical |
| Margin Shortfall     | Critical |
| Position Squared Off | Critical |

### SIP & Investment Events (SIPX)

| Event                  | Priority |
| ---------------------- | -------- |
| SIP Reminder           | Medium   |
| SIP Executed           | Medium   |
| SIP Failed             | Medium   |
| SIP Step-Up            | Medium   |
| Goal Milestone Reached | Medium   |

### Market Events (MKTX)

| Event                     | Priority |
| ------------------------- | -------- |
| Price Alert               | High     |
| Circuit Breaker Triggered | High     |
| Market Open               | High     |
| 52-Week High              | High     |

### Regulatory Events (REGX)

| Event                   | Priority |
| ----------------------- | -------- |
| KYC Expiry Reminder     | High     |
| Nominee Update Request  | High     |
| Contract Note Available | High     |
| Tax Statement Generated | High     |

---

## Key Features

### TRAI DND Compliance

The system validates SMS notifications against the DND registry immediately before dispatch rather than during routing. This eliminates race conditions where users register for DND after a notification has been routed but before delivery.

Transactional communications such as margin calls and trade confirmations bypass DND checks in accordance with applicable regulations.

---

### Frequency Capping

To prevent notification fatigue, the platform applies multi-dimensional rate limits:

| Rule                 | Limit           |
| -------------------- | --------------- |
| Global Notifications | 12 per user/day |
| SMS                  | 5 per user/day  |
| Push Notifications   | 8 per user/day  |
| Email                | 3 per user/day  |
| Category-Based Limit | 3 per hour      |
| Event Cooldown       | 15 minutes      |

Critical notifications bypass frequency caps while generating mandatory audit records.

---

### Circuit Breaker Failover

The platform implements a distributed circuit breaker using Redis.

```text
CLOSED
   │
   ▼
OPEN
   │
   ▼
HALF_OPEN
   │
   └──► CLOSED
```

Provider failover examples:

| Channel | Primary | Secondary |
| ------- | ------- | --------- |
| SMS     | MSG91   | Twilio    |
| Push    | FCM     | APNs      |

---

### Notification Delivery Pipeline

```text
Event
  │
  ▼
Deduplication
  │
  ▼
Enrichment
  │
  ▼
Routing
  │
  ▼
DND Validation
  │
  ▼
Frequency Cap Check
  │
  ▼
Quiet Hours Check
  │
  ▼
Template Rendering
  │
  ▼
RabbitMQ Queue
  │
  ▼
Delivery
  │
  ▼
Tracking
  │
  ▼
Analytics
```

---

### Multi-Language Templates

Supported languages include:

- English
- हिन्दी (Hindi)
- मराठी (Marathi)
- தமிழ் (Tamil)
- తెలుగు (Telugu)

Fallback order:

```text
Requested Locale
        ↓
     English
        ↓
 Default Template
```

---

## Testing

### Run Unit Tests

```bash
npm run test
```

### Run Unit Tests with Coverage

```bash
npm run test:cov
```

### Run End-to-End Tests

```bash
npm run test:e2e
```

> End-to-end tests require Kafka, RabbitMQ, Redis, and PostgreSQL to be running.

---

## Architecture Decision Records (ADR)

The project documents key architectural decisions under `docs/adr/`.

| ADR                                                          | Description                     |
| ------------------------------------------------------------ | ------------------------------- |
| [ADR-001](docs/adr/001-nestjs-fastify-adapter.md)            | NestJS with Fastify Adapter     |
| [ADR-002](docs/adr/002-kafka-over-rabbitmq-for-ingestion.md) | Kafka for Event Ingestion       |
| [ADR-003](docs/adr/003-redis-fail-open-strategy.md)          | Redis Fail-Open Strategy        |
| [ADR-004](docs/adr/004-dnd-check-at-dispatch.md)             | DND Validation at Dispatch Time |
| [ADR-005](docs/adr/005-prisma-over-knex.md)                  | Prisma ORM Selection            |

---

## Consent and Digests

Consent is an append-only evidence log enforced at dispatch (WhatsApp and promotional SMS/email); notifications can be delivered
as hourly/daily digests, and overnight or capped pile-ups fold into one. See [docs/consent-and-digests.md](docs/consent-and-digests.md).

## Nigeria Market

The engine also serves Nigeria (`market = 'NG'`): ₦ formatting, Nigerian Pidgin / Hausa / Yoruba / Igbo, Termii SMS,
and Paystack / Flutterwave / OPay / Interswitch payment webhooks. See [docs/nigeria-market.md](docs/nigeria-market.md).

## Document Error Log

The project includes a documented review of specification inconsistencies.

```text
docs/deliberate-error-log.md
```

This document contains the five deliberate errors identified during requirements analysis.

---

## Deployment

Refer to:

```text
DEPLOYMENT.md
```

See [DEPLOYMENT.md](DEPLOYMENT.md) for production deployment checklist.

for:

- Production deployment procedures
- Infrastructure requirements
- Security hardening checklist
- Monitoring setup
- Backup and recovery guidance
- Scaling recommendations

---

## Security

### Authentication & Authorization

- JWT-based authentication
- 1-hour access token TTL
- Refresh token rotation
- Role-Based Access Control (RBAC)

Supported roles:

- ADMIN
- OPERATOR
- SERVICE

### Data Protection

- AES-256-GCM encryption for PII at rest
- PII masking in logs
- Secure webhook signature validation
- Environment-based secret management

### Platform Security

- Sliding-window rate limiting
- Per-user throttling
- Per-IP throttling
- Non-root Docker containers
- Audit logging for critical operations

---

## Observability

### Metrics

Prometheus metrics are exposed via:

```text
GET /metrics
```

### Monitoring

Grafana dashboards provide visibility into:

- Delivery success rates
- Channel utilization
- Queue depth
- Provider latency
- Error rates
- Dead letter queue volume
- User opt-out trends

---

## License

This project is submitted as part of the **BE-6B — Event-Driven Notification Engine with Multi-Channel Delivery** engineering assessment and demonstrates production-grade backend architecture, distributed messaging patterns, resiliency engineering, compliance controls, and operational observability.

<!-- README.md — insert this section -->

## Bonus Features

Four bonus features were implemented beyond the core specification, each addressing a distinct extension point called out in the assessment roadmap.

**A/B testing on templates.** Templates can be marked as variants (`isAbVariant`, `abWeight` on the `Template` model) and users are deterministically bucketed via SHA-256 hashing of `(userId, eventType)`, so the same user always sees the same variant for a given event type — necessary for valid A/B comparison. Variant performance (delivery rate, read rate) is queryable via `GET /api/v1/templates/:eventType/ab-performance`.

<!-- README.md — in the Bonus Features section added earlier, append one line to the A/B testing / template section -->

All 27 event templates now have complete channel coverage (SMS, email, push, WhatsApp, in-app) verified via the notification preview API — including catching and fixing a template-loading bug where 22 empty on-disk template stub files were silently shadowing valid inline template definitions.

**Send-time optimization.** The system learns each user's peak engagement hour from read-receipt timestamps, using a Redis hash with exponential decay so recent behavior outweighs stale history. Non-urgent notifications are delayed (up to 4 hours) to the user's optimal hour rather than sent immediately. CRITICAL events and HIGH priority notifications always bypass this — latency SLA takes precedence over open-rate optimization for those.

**Real-time WebSocket dashboard.** A Socket.IO gateway at `/dashboard` broadcasts every notification state transition live. Ops/admin clients can subscribe to the full firehose; individual users can subscribe to their own notification stream for an in-app live feed. Gated behind `ENABLE_WEBSOCKET_DASHBOARD`.

**Notification preview API.** `POST /api/v1/notifications/preview` lets support and QA teams see exactly what a user would receive — across all channels, in their actual language, with their actual A/B variant — without sending anything. Useful for debugging "why did this user get this message" without side effects.
