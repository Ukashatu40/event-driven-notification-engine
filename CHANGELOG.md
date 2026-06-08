<!-- CHANGELOG.md -->

# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.0.0] — 2026-06-15 (Day 15 Submission)

### Added

**Infrastructure & Architecture**

- NestJS with Fastify adapter for 2-3× higher throughput than Express
- PostgreSQL 15 with Prisma ORM, table partitioning by `created_at`, BRIN indexes
- Redis 7 for frequency capping, deduplication, preference caching, retry queues
- Apache Kafka for high-volume event ingestion with idempotent producer
- RabbitMQ 3.12 with priority queues, dead letter exchanges, per-channel routing
- Docker Compose with health checks and resource limits for all services
- Multi-stage Dockerfile with non-root user (USER nestjs)
- GitHub Actions CI pipeline: lint → test → build → coverage → security scan

**Event Processing Pipeline**

- 25+ financial event types across 5 categories (TXNX, RISK, SIPX, MKTX, REGX)
- Two-layer deduplication: idempotency keys + SHA-256 event fingerprinting
- Full notification lifecycle state machine with immutable audit trail
- Weighted scoring routing engine (regulatory × 1000 + preference + delivery rate + cost)
- Correlation ID propagation from Kafka headers through all log entries

**Compliance**

- TRAI DND compliance with DND check at dispatch moment (not routing)
- Message classification: TRANSACTIONAL vs PROMOTIONAL
- Immutable consent audit log with timestamps and IP addresses
- Multi-dimensional frequency capping: global daily, per-channel daily, per-category hourly, cooldown
- Quiet hours enforcement with per-user IANA timezone resolution
- Morning digest aggregation for queued notifications (threshold: 5+)
- CRITICAL event bypass for all compliance checks with audit log entries

**Delivery**

- 5 delivery channels: SMS (MSG91 + Twilio failover), Email (Nodemailer), Push (FCM), WhatsApp (Cloud API), In-App
- Circuit breaker pattern: CLOSED → OPEN → HALF_OPEN per provider
- Provider failover: MSG91 → Twilio, FCM → APNs
- Exponential backoff retry with full jitter (corrected formula from spec)
- Priority-based retry configuration (CRITICAL: 10 retries, LOW: 2 retries)
- Dead letter queue with classification and manual resolution API

**Templates**

- Handlebars template engine with custom helpers
- 25+ event templates across SMS, email, push, WhatsApp, in-app
- 5-language support: English, Hindi, Marathi, Tamil, Telugu
- Localisation fallback chain: requested locale → EN → hardcoded default
- SMS 160-character truncation with word-boundary preservation
- A/B testing support via template versioning

**User Preferences**

- 4-layer preference hierarchy: system defaults → segment → user → regulatory override
- Redis cache with immediate invalidation on update
- Per-category digest mode configuration
- Regulatory override channels that cannot be disabled

**Analytics & Observability**

- Prometheus metrics endpoint at `/metrics` with 9 metric families
- Real-time sliding window counters via Redis sorted sets
- Analytics API: delivery rates, channel performance, opt-out trends, realtime stats
- Structured JSON logging via Pino with PII redaction
- Three-pillar observability: metrics + logs + correlation IDs
- Health check endpoints: `/health`, `/ready`, `/live`

**Security**

- JWT authentication with 1-hour TTL and refresh token rotation
- RBAC with ADMIN, OPERATOR, SERVICE roles
- AES-256-GCM column-level PII encryption
- PII masking in all log output
- Sliding window rate limiting per IP and per user
- Webhook HMAC signature verification
- GDPR-style right-to-erasure endpoint

**Documentation**

- OpenAPI 3.0 spec with Swagger UI at `/api-docs`
- 5 Architecture Decision Records
- Document Error Log identifying all 5 deliberate specification errors
- C4 architecture diagrams in ARCHITECTURE.md
- Complete deployment guide in DEPLOYMENT.md

### Fixed

- Retry formula: corrected `baseDelay * 2^attempt` to `baseDelay * 2^(attempt-1)`
- user_preferences PRIMARY KEY: replaced invalid COALESCE expression with composite unique index
- REGX-005 priority: raised from LOW to MEDIUM to meet 24-hour SLA with retry budget
- Frequency cap evaluation order: most-specific first (cooldown → hourly → daily → global)

### AI Acceleration Notes (per Section E4)

- Docker Compose configuration scaffolded with AI, reviewed and customised
- GitHub Actions CI pipeline scaffolded with AI, all steps verified
- Handlebars helper registration pattern from AI suggestion, adapted for locale system
- All business logic (compliance rules, routing algorithm, circuit breaker) written manually
