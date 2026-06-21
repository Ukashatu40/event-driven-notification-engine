<!-- CHANGELOG.md -->

# Changelog — Daily Progress Log

All daily deliverables for BE-6B Event-Driven Notification Engine.
AI acceleration noted per section E4 guidelines.

---

## Day 1 — Project Setup & Architecture Design

**Deliverables:** Git repository, Docker Compose, architecture docs, event taxonomy YAML

- Created private GitHub repository `BE-6B-NotificationEngine-UkashatuAbdullahi`
- Initialised NestJS/TypeScript project with `strict: true`, `noImplicitAny: true`
- Set up project structure: `src/`, `tests/`, `docs/`, `config/`, `scripts/`, `migrations/`
- Configured ESLint `@typescript-eslint/recommended` + Prettier
- Docker Compose with: PostgreSQL 15, Redis 7, Kafka (Confluent 7.5), RabbitMQ 3.12
- Created `.env.example` with all required environment variables
- Wrote initial `README.md` with project overview and ADRs
- Created `docs/architecture.md` with C4 system context, container, and component diagrams
- Documented technology choices with justification (ADR-001 through ADR-006)
- Designed event processing pipeline: Kafka ingestion → enrichment → routing → RabbitMQ → delivery
- Defined OpenAPI 3.0 contracts for all internal services
- Created `docs/event-taxonomy.yaml` with all 25 event type definitions across 5 categories
- **Git commit:** `feat: initial project setup with Docker Compose and architecture docs`
- _AI acceleration:_ Docker Compose boilerplate scaffolded with AI, reviewed and customised

---

## Day 2 — Database Schema & Event Models

**Deliverables:** Migrations, TypeScript event models, Zod validators, seed data

- Implemented Prisma migrations for all core tables: `users`, `notifications`,
  `notification_state_log`, `dead_letter_queue`, `user_preferences`, `templates`,
  `delivery_attempts`, `consent_records`, `provider_health`
- Table partitioning strategy documented; raw SQL migration prepared for production
- Created all indexes: composite `(user_id, status, channel)`, BRIN on `created_at`,
  GIN on `personalisation_data`, partial index on `status WHERE IN ('QUEUED','RETRYING')`
- Wrote seed data script for 1,000 test users with varied preferences, languages, DND status
- Defined TypeScript interfaces for all 25+ event types with strict typing
- Implemented Zod validation for all event payloads
- Created event factory pattern for generating test events
- Unit tests for all event validators (20+ test cases)
- **Git commit:** `feat: database schema, migrations, event models, and validation`

---

## Day 3 — Event Ingestion Pipeline

**Deliverables:** Kafka producer/consumer, routing engine, deduplication

- Configured Kafka topics: `notification-events` (6 partitions), `notification-critical`,
  `notification-dlq`
- Implemented idempotent Kafka producer (`enable.idempotence=true`)
- Consumer groups with manual offset management for at-least-once delivery
- JSON Schema serialisation with schema evolution support
- Event enrichment: user context resolution, preference hierarchy, channel determination
- Built routing engine with 4-priority weighted scoring model (regulatory → user → delivery → cost)
- Event deduplication using Redis SHA-256 fingerprinting with TTL-based idempotency keys
- Integration tests: produce event → consume → route
- **Git commit:** `feat: Kafka-based event ingestion pipeline with routing engine`
- _AI acceleration:_ Kafka consumer group configuration reviewed with AI for offset management edge cases

---

## Day 4 — Template Engine & Personalisation

**Deliverables:** Handlebars engine, 25+ templates, 5-language localisation

- Implemented Handlebars-based template engine with custom helpers: `formatCurrency`,
  `formatDate`, `truncateSms`
- Template registry loading from inline definitions with JSON file override support
- Template versioning with A/B testing variant resolution
- Personalisation pipeline: user context → derived fields → locale formatting → render
- Localisation for English, Hindi, Marathi, Tamil, Telugu with fallback chain
- SMS truncation logic preserving meaning within 160 chars using ellipsis + link
- Created templates for all 25 event types across all relevant channels
- Unit tests for template rendering: missing fields, long names, special characters, locale
  fallback (30+ test cases)
- **Git commit:** `feat: template engine with personalisation and localisation`

---

## Day 5 — User Preference System

**Deliverables:** Preference API, hierarchy resolver, Redis caching

- Implemented `GET /api/v1/users/:userId/preferences` and `PUT /api/v1/users/:userId/preferences`
- Built 4-layer preference hierarchy resolver: system defaults → segment → user → regulatory override
- Redis caching with TTL-based invalidation on update
- Preference migration logic: default preferences applied on first access
- Integrated preference system with routing engine from Day 3
- Digest mode: batch low-priority notifications for hourly or daily delivery
- API tests for all preference endpoints
- **Git commit:** `feat: user preference system with caching and routing integration`

---

## Day 6 — DND Compliance & Frequency Capping

**Deliverables:** DND service, frequency capping, quiet hours, consent management

- DND registry lookup service with Redis cache (24h TTL, database fallback)
- TRANSACTIONAL vs PROMOTIONAL classification engine for all 25 event types
- Consent management with immutable audit log (`consent_records` table)
- DND check implemented at LAST moment before SMS dispatch (not during routing)
- Multi-dimensional frequency capping using Redis atomic INCR operations:
  - Global daily: 12 notifications/rolling 24h
  - Per-channel: SMS 5, Push 8, Email 3
  - Per-category hourly: 3
  - Cooldown: 15 min between same event type
  - CRITICAL events bypass all caps with audit log
- Quiet hours enforcement: default 21:00–08:00 per IANA timezone, CRITICAL bypass
- Quiet hours queue aggregates into morning digest when count exceeds 5
- 25+ test cases covering all edge cases including CRITICAL bypass and regulatory exemptions
- **Git commit:** `feat: DND compliance, consent management, frequency capping, quiet hours`

---

## Day 7 — Multi-Channel Delivery Providers

**Deliverables:** 5 delivery providers, circuit breaker, provider health monitoring

- Defined `DeliveryProvider` interface per spec Section A3.3
- MSG91 sandbox SMS provider with DLR callback support
- Twilio test mode SMS provider (failover from MSG91)
- Nodemailer + Ethereal test SMTP email provider with HTML templates
- FCM HTTP v1 API push notification provider
- WhatsApp Cloud API provider with template message support
- In-app notification provider via Socket.io WebSocket
- Provider-level rate limiting with exponential backoff
- Circuit breaker pattern: CLOSED → OPEN → HALF_OPEN, 5-failure/60s threshold
- Provider health check mechanism persisted in `provider_health` table
- Integration tests with mock servers for each provider
- **Git commit:** `feat: multi-channel delivery providers with circuit breaking`

---

## Day 8 — Delivery Routing & Failover Engine

**Deliverables:** Channel scoring, multi-channel fan-out, provider failover

- Priority-weighted channel scoring model (regulatory → user prefs → delivery rate → cost)
- Multi-channel fan-out for simultaneous delivery across all targeted channels
- Channel failover: primary channel failure → next-best channel within same priority
- Delivery acknowledgement tracking persisted to `delivery_attempts`
- Circuit breaker: MSG91 fails → Twilio; FCM fails → in-app fallback
- Idempotency checks prevent duplicate delivery during failover
- Failover simulation test suite
- **Git commit:** `feat: intelligent routing engine with failover and circuit breaking`

---

## Day 9 — Retry Strategy & Dead Letter Queue

**Deliverables:** Exponential backoff retry, DLQ processing, management API

- Exponential backoff with jitter: `min(baseDelay * 2^attempt + jitter(0,1000), maxDelay)`
- Priority-based retry configs: CRITICAL 10/500ms/60s, HIGH 5/1s/5min, MEDIUM 3/5s/30min,
  LOW 2/30s/2hr
- Redis sorted sets for retry scheduling (`ZADD` with retry timestamp as score)
- Retry budget monitoring prevents retry storms
- DLQ consumer processes failed notifications after max retries exceeded
- DLQ management API: `GET /dlq`, `PATCH /dlq/:id/resolve` (retry | discard | manual_send)
- Automated DLQ classification: transient vs permanent vs configuration error
- DLQ depth alert when threshold exceeded (Prometheus gauge + structured log)
- **Git commit:** `feat: retry strategy with exponential backoff and DLQ processing`

---

## Day 10 — Analytics Pipeline

**Deliverables:** Real-time counters, analytics API, Prometheus metrics

- Real-time sliding window counters in Redis: delivery counts, failure counts, latency
- Analytics API endpoints:
  - `GET /api/v1/analytics/delivery-rates`
  - `GET /api/v1/analytics/channel-performance`
  - `GET /api/v1/analytics/opt-out-trends`
- Prometheus `/metrics` endpoint exposing all 9 required metrics per spec Section A11.1
- Event-sourced analytics derived from `notification_state_log`
- Time-series aggregation queries using BRIN-indexed `created_at`
- Cost analytics: per-channel, per-event-type cost tracking in paisa
- **Git commit:** `feat: real-time analytics pipeline with metrics and API`

---

## Day 11 — Load Testing & Performance Optimisation

**Deliverables:** k6 load test scripts, P50/P95/P99 benchmarks, query optimisation

- k6 load test scenarios: normal (2M/day), peak (10x), market crash (20x / 450K in 30min)
- P50/P95/P99 latency measurements per channel and priority under each scenario
- Connection pooling tuned for PostgreSQL (max 20) and Redis (max 50)
- Kafka consumer parallelism tuning: 6 partitions, 6 consumer instances per group
- Database query optimisation: EXPLAIN ANALYZE outputs in `docs/performance-benchmarks.md`
- Identified hot path: template rendering under peak — resolved with compiled template caching
- **Git commit:** `feat: load testing suite and performance optimisations`

---

## Day 12 — Error Handling, Logging & Monitoring

**Deliverables:** Structured logging, correlation IDs, health checks, graceful shutdown

- Pino structured JSON logging with correlation IDs propagated through Kafka headers
- Log levels: WARN in production, DEBUG in development
- PII redaction in logs: phone numbers, emails, authorization headers
- `GlobalExceptionFilter` with error classification (transient | permanent | validation)
- Health check endpoints: `/health`, `/ready`, `/live` checking all infrastructure deps
- Graceful shutdown: drain in-flight queues before SIGTERM
- Alerting rules documented in `docs/architecture.md` (DLQ depth, circuit open, latency spike)
- **Git commit:** `feat: structured logging, error handling, health checks, graceful shutdown`

---

## Day 13 — API Documentation & Comprehensive Testing

**Deliverables:** OpenAPI spec, Swagger UI, Postman collection, 80%+ coverage

- OpenAPI 3.0 specification at `docs/api-specification.yaml`
- Swagger UI at `/api-docs`
- Postman collection at `docs/postman-collection.json` with pre-configured test requests
- End-to-end tests: event ingestion → processing → routing → delivery → tracking
- Edge case tests: DND user receiving mandatory margin call, preference change mid-delivery,
  provider failover during active notification
- Test coverage report generated with `npm run test:cov`
- **Git commit:** `feat: OpenAPI docs, Swagger UI, comprehensive test suite`

---

## Day 14 — Containerisation, CI/CD & Security

**Deliverables:** Multi-stage Dockerfile, GitHub Actions CI, security hardening

- Multi-stage Dockerfile: builder → production, non-root user `nestjs`
- Docker image optimised with `.dockerignore`
- GitHub Actions CI: lint → test → build → coverage report → npm audit → secrets scan
- Rate limiting: 100/min standard, 1000/min webhooks, 10/min preferences (sliding window)
- JWT authentication on all endpoints with ADMIN/OPERATOR/SERVICE RBAC roles
- Webhook HMAC-SHA256 signature validation for all provider callbacks
- `SERVICE_API_KEY` in `.env.example` for service authentication
- **Git commit:** `feat: Docker, CI/CD pipeline, security hardening`

---

## Day 15 — Final Documentation, Bonus Features & Repository Transfer

**Deliverables:** Complete README, ARCHITECTURE.md, DEPLOYMENT.md, bonus features, repo transfer

- Completed README.md with all sections including Document Error Log
- ARCHITECTURE.md with sequence diagrams for margin call, frequency cap, provider failover
- DEPLOYMENT.md with production deployment checklist
- GDPR right-to-erasure endpoint: `DELETE /api/v1/users/:userId/data`
- 90-day data retention scrubbing scheduled job (runs daily at 02:00 UTC)
- Webhook DLR controllers for SMS (MSG91, Twilio), push (FCM), and WhatsApp
- **Bonus B3.4 — A/B testing:** Deterministic SHA-256 bucketing with conversion tracking
- **Bonus B3.4 — Notification preview:** `POST /api/v1/notifications/preview`
- **Bonus B3.4 — Send-time optimisation:** Per-user hourly engagement scoring with decay
- **Bonus B3.4 — WebSocket dashboard:** Real-time metrics via Socket.io
- Repository transferred to @ZethetaIntern
- **Git commit:** `chore: final documentation and cleanup for repository transfer`
- _AI acceleration:_ Claude used throughout for code review, error diagnosis, and spec compliance audit

---

## Document Error Log

Five deliberate errors were found in the spec. Full analysis: `docs/deliberate-error-log.md`
