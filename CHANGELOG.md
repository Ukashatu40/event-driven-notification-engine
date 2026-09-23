<!-- CHANGELOG.md -->

# Changelog — Daily Progress Log

All daily deliverables for BE-6B Event-Driven Notification Engine.
AI acceleration noted per section E4 guidelines.

---

## Post-Day-15 (6) — free multi-cloud deployment path

- **`DEPLOYMENT-CLOUD.md`**: a separate deployment target from the Docker Compose guide — Postgres on Neon, Redis + Kafka on
  Upstash, RabbitMQ on CloudAMQP, the app on Render, the console on Vercel. All free tiers, verified against each provider's
  current docs rather than assumed. `.env.cloud.example` maps each provider's dashboard value to the right env var.
- Fixed a real bug found while wiring this up: `prisma.config.js` (a Prisma 7 config file, at the project root) was never actually
  copied into the **production** Docker stage — only into `builder`, which is why the existing `migrate` Compose service (which
  runs from `builder`) worked while a from-scratch attempt to run `prisma migrate deploy` from the production image failed with a
  misleading "datasource.url is required" even though `DATABASE_URL` was set correctly. Fixed by copying it explicitly in both
  stages; also converted it from `.ts` to plain `.js` so it needs no TypeScript at runtime (a devDependency, correctly not shipped
  in production) — one less way for config loading to silently do nothing.
- `prisma` moved from `devDependencies` to `dependencies` — the CLI needs to be resolvable at runtime for the new optional
  migrate-on-boot path below (verified: it was silently absent from the production image before this).
- New `docker/entrypoint.sh`, opt-in via `RUN_MIGRATIONS_ON_BOOT=true`: runs `prisma migrate deploy` once before the app starts,
  for a host (Render) with no equivalent to Compose's one-shot `migrate` service. Unset locally, so Compose is unaffected —
  verified both paths directly (migrations-then-healthy-boot with the flag set; unchanged normal boot without it).
- `REDIS_TLS` (`src/infrastructure/redis/redis.service.ts`): Upstash Redis requires TLS; the ioredis client had no `tls` option at
  all. Same "explicit, never inferred from `NODE_ENV`" pattern as `KAFKA_SSL`.
- `npm run seed:me -- --email=you@example.com` creates/updates one user with a real, chosen email (and optionally phone) — the
  bulk-seeded users have fake test contact details that can never actually receive an OTP.
- `npm run whoami` prints a few real seeded users' decrypted contact details, for local testing only.
- Portal/ops login pages now cross-link to each other (`/login` ↔ `/portal/login`) — previously reachable only by typing the URL.

## Post-Day-15 (5) — end-user login and self-service (ADR-008)

- **Phone/email + OTP login for end users**: `POST /api/v1/auth/otp/request` and `/verify` issue a new `USER`-role token — no static
  credential exists for it, only OTP verification. The code is sent synchronously through the existing SMS/email providers, is never
  stored (only its hash, 5 min TTL), and both endpoints are enumeration-safe (identical response/failure whether or not the identifier
  is registered).
- **`/api/v1/me/*`**: profile, preferences, consent (history/status/record), notifications and mark-as-read — every handler takes its
  id from the verified token, never from a route parameter, so there is no ownership check to get wrong. Delegates to the existing
  preferences/consent/notifications services; no logic duplicated.
- **`GET /api/v1/users`**: search/list users by name or exact id (`src/users/`) — the console had no way to find a user besides pasting
  a UUID. Never returns phone/email, even ciphertext.
- Fixed a real bug found while building the above: `POST /notifications/:id/read` wrote `status: READ` directly and then asked the
  state machine to also transition to READ, which always rejected its own READ→READ and 422'd — the endpoint never worked. It now
  makes one transition and nothing else.
- Fixed `NotificationPreviewService` never passing `currency` to the renderer, so every preview showed ₹ regardless of the user's
  market. Added the missing SMS template for TXNX-004 and email template for TXNX-005 (both previously undefined for that channel).
- `GET /notifications/:id` now additionally returns `user_name` (additive; `user_id` unchanged).
- `rbac-policy.spec.ts`'s controller list — a hand-maintained list, not an automatic scan — had silently not covered `UsersController`
  since it shipped; fixed, and the new controllers were added in the same change that introduces them.

## Post-Day-15 (4) — deployment hardening

- **Preflight** (`scripts/bash/deploy/preflight.sh`): refuses unsafe configs (missing/short/placeholder/reused secrets, `NODE_ENV`, localhost CORS, `CONSENT_ENFORCEMENT=off`, tracked `.env`, invalid compose/alert rules); never prints values.
- **Auth**: `JWT_REFRESH_SECRET` must differ from `JWT_SECRET` (startup validation); tokens carry a `typ` claim and the guard accepts only `access` tokens, so a refresh token can no longer be used as a bearer.
- **Kafka TLS** is now opt-in via `KAFKA_SSL=true` (it was wrongly forced on by `NODE_ENV=production`, which broke the bundled plaintext broker).
- **Docker**: `.dockerignore` (keeps `.env*`, `.git`, tests, docs out of image layers); healthchecks use `127.0.0.1` (Alpine resolved `localhost` to `::1`); one-shot `migrate` service runs `prisma migrate deploy` and `app` waits for it; obsolete compose `version:` removed.
- **DEPLOYMENT.md** rewritten: secrets, preflight, verified deploy steps, consent rollout plan, alert runbook, failure behaviour, rollback, repository transfer.

## Post-Day-15 (3) — consent API, digest aggregation, generated API docs

- **Consent API** (`POST/GET /api/v1/users/:id/consents`, `…/status`), **append-only in Postgres** (trigger), enforced at dispatch for
  WhatsApp and promotional SMS/email (`NO_CONSENT` state, `CONSENT_ENFORCEMENT=enforce|audit|off`), authorising record stored on
  each notification, and two audit endpoints (`/compliance/audit/sms`, `/promotional-consent`). `ConsentService` previously existed
  but nothing called it. Erasure now retains consent evidence. ADR-006.
- **Digest aggregation**: user-chosen hourly/daily digests, "more than 5 overnight → one morning digest" (spec: *exceeds* 5, was `>=`),
  and "3+ capped → digest". New `DIGEST_PENDING`/`DIGESTED` states, `DigestBucketService`/`DigestFlushService`, CRITICAL and mandated
  events never digested, nothing lost on failure. Digest preferences were previously stored and ignored. ADR-007.
- **Generated API docs**: `npm run docs:openapi` builds `docs/api-specification.{json,yaml}` from the controllers (the YAML was a
  15-line stub, the JSON stale); CI runs it with `--check`. Postman collection fixed for the un-enveloped responses and extended.
- **Fixed while here:** e2e suite left users behind and failed in `afterAll` (only caught because the suite line, not just the test
  line, was checked); a leftover `logger.debug('Debugging')` ×2 removed.
- **Tests:** 731 unit, 26 integration, 36 e2e (real Postgres/Redis/Kafka/RabbitMQ).

## Post-Day-15 (2) — contract, security, operations, tests

- **API contract (spec Appendix A):** snake_case in and out, no `{success,data}` envelope, 422 `VALIDATION_FAILED` with field
  details, `CREATED` first in the state history, lowercase digest modes, `total_inr`. The spec's own example requests were previously
  *rejected* (camelCase DTOs behind `forbidNonWhitelisted`; `PUT /preferences` failed on an undecorated `channels` field).
- **Security:** RBAC was not enforced anywhere (no route declared `@Roles`) — now every route has a policy, enforced by a test.
  `login` let the caller pick any role — now one credential per role. Real refresh-token rotation with reuse detection. Redis
  sliding-window rate limiting. DLR webhooks fail closed. The dashboard WebSocket was open to anonymous clients — now authenticated.
- **Operations:** `/health` `/ready` `/live` `/metrics` were 404 under the `api` prefix (so Prometheus scraping and the container
  HEALTHCHECK were failing) — now at the root. Correlation-id and request-logger middleware were never registered — now are.
  Prometheus alert rules (7, validated with `promtool`); `kafka_consumer_lag` and `notification_retry_total` were defined but never
  emitted — now are; DND-violation tripwire; `/health` now reports providers; Redis dangerous commands disabled; Postgres TLS; Node 20.
- **Correctness:** DLQ retry marked entries resolved then threw (illegal `DLQ → RETRYING` transition) — rewritten, with
  classification (TRANSIENT/PERMANENT/CONFIGURATION), filters and 409 on double-resolve. The 90-day PII retention job matched no
  rows. Channel-performance analytics returned fabricated 96% delivery figures — now computed from real data; "sent" no longer
  counts suppressed notifications. Mock-mode providers now emit a labelled *simulated* receipt so analytics/latency work in dev.
  6-hour minimum quiet window enforced; CRITICAL bypasses are audited in the state log. Template JSON files were invalid and
  silently ignored (and the RISK-001 file was a stale draft missing the square-off warning) — regenerated and drift-tested.
- **Tests:** 21.7% → 88% line coverage (thresholds now enforced at 80/80/75/60); 638 unit + 19 integration + 22 e2e tests. E2E
  boots the real app against real Postgres/Redis/Kafka/RabbitMQ (`npm run test:e2e`, `npm run test:integration`).
- **CI:** lint gate (errors fail), promtool rule check, and an integration/e2e job on `docker-compose.test.yml` (`REQUIRE_INFRA=true`).
- **Structure:** `src/database/{seeds,models}`, `src/api/{routes,validators}`, `src/utils`, `src/events/taxonomy.yaml`,
  `tests/{integration,e2e}` (seeds moved from `scripts/`; `npm run prisma:seed`, `seed:ng`, `seed:dnd-cache`).
- _AI acceleration:_ Claude found the defects above by running the system against real infrastructure rather than reading it, and
  wrote the regression tests; each fix is covered by a test that fails without it.

## Post-Day-15 — pipeline wiring, PII, partitioning, Nigeria pack

- **Fixed: the delivery pipeline was not wired.** Nothing consumed the RabbitMQ queues or called `DeliveryService`,
  Kafka was not on the ingestion path, and publish threw on an invalid `QUEUED → QUEUED` transition. Added Kafka ingestion
  (critical/standard consumer groups, dead-letter topic), per-channel notification rows, delivery workers, retry republish,
  and a scheduled release for quiet-hours / send-time-optimised notifications.
- **DND now checked at dispatch** (ADR-004), with the result persisted (`dndChecked`, `dndCheckTimestamp`, `dndResult`),
  registry looked up for every SMS, promotional fails closed when the registry is down.
- **Partitioned `notifications`** monthly (`PRIMARY KEY (id, "createdAt")`; child FKs dropped — see docs/database-schema.md).
- **PII encrypted at rest** (AES-256-GCM `enc:v1:`), HMAC blind indexes for uniqueness/lookup, addresses resolved at send time
  and never placed on the broker or in DLQ payloads. `npm run pii:encrypt` backfills existing rows.
- **Fixed:** dedup fingerprint collapsed distinct same-type events (second deposit / margin call dropped); one multi-channel
  event burned the whole category-hourly cap; quiet-hours branch deferred an empty channel list; regulator-mandated events were
  swallowed by the same-type cooldown; SMS with `₹`/`₦` silently became 70-char UCS-2.
- **Nigeria pack:** market profiles, Pidgin/Hausa/Yoruba/Igbo, ₦ formatting, Termii SMS, Paystack/Flutterwave/OPay/Interswitch
  payment webhooks. See docs/nigeria-market.md.
- _AI acceleration:_ Claude audited the repo against the spec, found and fixed the above, and wrote the tests; provider webhook
  schemes were checked against the providers' public docs.

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
- Repository-transfer checklist documented in DEPLOYMENT.md
- **Git commit:** `chore: final documentation and cleanup`
- _AI acceleration:_ Claude used throughout for code review, error diagnosis, and spec compliance audit

---

## Document Error Log

Five deliberate errors were found in the spec. Full analysis: `docs/deliberate-error-log.md`
