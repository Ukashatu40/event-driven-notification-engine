# Deployment Guide

BE-6B Event-Driven Notification Engine. This guide is verified: the stack below was built and booted with
`docker compose up -d --build`, all containers reported healthy, Prometheus scraped the app, and a real margin call was delivered
through the containerised app.

## 1. What runs

| Service | Image | Purpose | Notes |
|---|---|---|---|
| `app` | built from `Dockerfile` (target `production`, Node 20, non-root `nestjs`) | API + Kafka consumers + delivery workers + schedulers | health: `GET /ready` |
| `migrate` | same Dockerfile, target `builder` | one-shot `prisma migrate deploy` | `app` waits for it to **succeed** |
| `postgres` | postgres:15 | primary store, TLS on | certs from the `postgres-certs` init container |
| `redis` | redis:7 | caps, dedup, digests, rate limits, refresh tokens | password; `FLUSHALL/FLUSHDB/KEYS/DEBUG` disabled |
| `kafka` + `zookeeper` | Confluent 7.5 | event ingestion (`notification-critical`, `notification-events`, `notification-dlq`) | |
| `rabbitmq` | 3.12 | per-channel priority queues + DLX | |
| `prometheus`, `grafana` | | metrics, 7 alert rules (`monitoring/alert-rules.yml`) | |

The app is stateless: run several replicas behind a load balancer. Kafka partitions and RabbitMQ consumers are shared between them.

## 2. Before you deploy

### 2.1 Secrets

Generate them, put them in your secrets manager (or a `.env` that is **never committed**):

```bash
openssl rand -hex 32   # JWT_SECRET
openssl rand -hex 32   # JWT_REFRESH_SECRET   (must differ from JWT_SECRET — the app refuses to start otherwise)
openssl rand -hex 32   # PII_ENCRYPTION_KEY   (exactly 64 hex chars)
openssl rand -hex 32   # PII_HASH_KEY
openssl rand -hex 24   # SERVICE_API_KEY, OPERATOR_API_KEY, ADMIN_API_KEY — one each
openssl rand -hex 16   # DB_PASSWORD, REDIS_PASSWORD, RABBITMQ_PASSWORD, WEBHOOK_SIGNATURE_SECRET, GRAFANA_PASSWORD
```

> **Back up `PII_ENCRYPTION_KEY` separately from the database.** Phone numbers and emails are unrecoverable without it.
> Passwords go into connection URLs — avoid `@ : / ? #` or URL-encode them.

### 2.2 Preflight (run it — it blocks unsafe configurations)

```bash
scripts/bash/deploy/preflight.sh .env.production
```

It fails on: missing/short/placeholder secrets, reused secrets, `NODE_ENV != production`, localhost CORS, `CONSENT_ENFORCEMENT=off`,
a tracked `.env`, invalid compose/alert rules. It warns about providers still in mock mode and unencrypted Kafka. It never prints a secret.

### 2.3 Environment reference

| Variable | Required | Meaning |
|---|---|---|
| `NODE_ENV` | ✔ | `production` |
| `DATABASE_URL`, `DB_HOST/PORT/NAME/USER/PASSWORD` | ✔ | add `sslmode=require` (or `verify-full` with your CA) |
| `REDIS_HOST/PORT/PASSWORD` | ✔ | |
| `KAFKA_BROKERS`, `KAFKA_CLIENT_ID`, `KAFKA_GROUP_ID_STANDARD/CRITICAL` | ✔ | |
| `KAFKA_SSL` | | `true` for a TLS broker (**not** inferred from `NODE_ENV`); default `false` |
| `RABBITMQ_URL`, `RABBITMQ_USER/PASSWORD` | ✔ | |
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | ✔ | must differ |
| `PII_ENCRYPTION_KEY`, `PII_HASH_KEY` | ✔ | |
| `SERVICE_API_KEY`, `OPERATOR_API_KEY`, `ADMIN_API_KEY` | | a role with no key cannot log in |
| `WEBHOOK_SIGNATURE_SECRET`, `SMTP_HOST`, `SMTP_FROM` | ✔ | |
| `CORS_ORIGINS` | ✔ | comma-separated real origins |
| `CONSENT_ENFORCEMENT` | | `enforce` (default) \| `audit` \| `off` — see §4.2 |
| `MSG91_*`, `TERMII_*`, `TWILIO_*`, `FCM_PROJECT_ID`, `WHATSAPP_*`, `SMTP_USER/PASS` | | without a key a provider runs in **mock mode** (simulated, labelled receipts) |
| `PAYSTACK_SECRET_KEY`, `FLUTTERWAVE_SECRET_HASH`, `OPAY_SECRET_KEY`, `INTERSWITCH_SECRET_KEY` | | a payment webhook whose secret is unset **rejects everything** |
| `KAFKA_CONSUMERS_ENABLED`, `DELIVERY_WORKERS_ENABLED`, `SCHEDULED_RELEASE_ENABLED`, `DIGEST_ENABLED`, `KAFKA_LAG_MONITOR_ENABLED` | | `false` turns that worker off — for API-only or worker-only replicas |

## 3. Deploy

```bash
docker compose up -d --build        # builds, runs migrations, starts everything
docker compose ps                   # every service healthy; `migrate` exited 0
docker logs notification_migrate    # "All migrations have been successfully applied" / "No pending migrations"
```

Order is enforced by compose: postgres healthy → `migrate` succeeded → `app` starts. A failed migration stops the release; the
previous containers keep serving.

### 3.1 Post-deploy verification

```bash
curl -fsS localhost:3000/health | jq '{status, components: (.components|map_values(.status))}'
#  → healthy; database, redis, kafka, rabbitmq, providers all "up"
curl -fsS localhost:3000/metrics | grep -c '^notification_'          # metrics flowing
curl -s 'localhost:9090/api/v1/targets' | jq -r '.data.activeTargets[] | "\(.labels.job) \(.health)"'   # → up
curl -s 'localhost:9090/api/v1/rules'   | jq '[.data.groups[].rules[]] | length'                        # → 7
```

Then a real event (use the SERVICE key):

```bash
TOKEN=$(curl -s localhost:3000/api/v1/auth/login -H 'content-type: application/json' \
  -d "{\"serviceKey\":\"$SERVICE_API_KEY\",\"role\":\"SERVICE\"}" | jq -r .access_token)
# POST /api/v1/events (see docs/api-specification.json or the Postman collection), then
# GET /api/v1/notifications/<id> → state_history CREATED … SENT/DELIVERED, compliance block populated
```

Swagger UI: `/api-docs`. The full contract lives in `docs/api-specification.{json,yaml}`, generated from the code (`npm run docs:openapi`).

## 4. Migrating existing data

### 4.1 Encrypt existing PII (once)

```bash
npm run pii:encrypt        # idempotent; encrypts phone/email, fills the blind indexes
```

Until it has run, the app logs a warning and passes plaintext through so nothing breaks during the rollout window.

### 4.2 Consent — do not flip to `enforce` blind

Existing users have **no consent records**, and none may be fabricated. With `CONSENT_ENFORCEMENT=enforce`, WhatsApp and promotional
SMS/email to them would be blocked (state `NO_CONSENT`). Roll out in this order:

1. Deploy with `CONSENT_ENFORCEMENT=audit` — sends continue, each missing consent is logged and counted
   (`notification_consent_blocks_total{mode="audit"}`).
2. Record **real** consent through `POST /api/v1/users/:id/consents` as users opt in (include their IP and the exact wording shown).
3. When the audit count is acceptable (or zero for the channels you care about), set `enforce` and redeploy.

`npm run seed:consent` adds *synthetic* consent for development data only and refuses to run with `NODE_ENV=production`.

## 5. Operations

### 5.1 Alerts (see `monitoring/alert-rules.yml`)

| Alert | Fires when | First response |
|---|---|---|
| `HighDLQDepth` | DLQ > 100 for 5 min | `GET /api/v1/dlq?classification=CONFIGURATION` first — those need a fix, not a retry; then TRANSIENT → `PATCH /dlq/:id/resolve {"action":"retry"}` |
| `ProviderCircuitOpen` | a provider's breaker is OPEN | SMS fails over automatically (MSG91/Termii → Twilio). Check the provider status page; it half-opens by itself after 60 s |
| `DeliveryLatencySpike` | CRITICAL P99 > 30 s | check `KafkaConsumerLag` on `notification-critical`, RabbitMQ `notifications.*` queue depth |
| `HighFailureRate` | > 5 % failed over 10 min | `GET /api/v1/analytics/channel-performance` to find the provider |
| `KafkaConsumerLag` | lag > 10 000 for 5 min | add app replicas (Kafka partitions bound the parallelism) |
| `DNDViolationDetected` | tripwire counter > 0 | **page compliance.** The send was refused, but the policy check has a bug |
| `FrequencyCapExhaustion` | > 50 % of events hit the daily cap | review notification volume / digests |

### 5.2 Failure behaviour

| Failure | Behaviour |
|---|---|
| Redis down | rate limiting fails **open** (logged); frequency caps degrade (see ADR-003); refresh/dedup unavailable → requests error rather than skip safety checks |
| Kafka down | `POST /events` → `503`, the dedup claim is released so the caller's retry is not called a duplicate |
| RabbitMQ down | engine dead-letters what it cannot queue (visible in the DLQ) |
| DND registry / consent lookup down | promotional send is **withheld and retried**, never sent blind |
| Provider down | circuit breaker → failover → retry with backoff → DLQ |
| App crash mid-flight | unacked RabbitMQ messages are redelivered; a duplicate for an already-`SENT` notification is dropped |

### 5.3 Scaling

Run more `app` replicas (Kafka consumer groups and RabbitMQ prefetch spread the work; ZREM-claimed schedulers never double-process).
To split roles, run some replicas with `KAFKA_CONSUMERS_ENABLED=false DELIVERY_WORKERS_ENABLED=false` (API only) and others with the
workers on. Kafka partitions (6 standard / 3 critical) cap consumer parallelism — raise them **before** you need to.

### 5.4 Rollback

Migrations are additive and forward-only. To roll back the **code**: redeploy the previous image — it runs against the newer schema
(new columns/enum values are ignored by old code). Do not `prisma migrate reset` in production. The consent log is append-only by design.

### 5.5 Backups

Back up Postgres (notifications, consent evidence, state log), and `PII_ENCRYPTION_KEY` **separately**. Redis holds only reconstructible
or short-lived state (caps, dedup, digest buckets, refresh tokens — losing it logs users out and drops un-flushed digests).

## 6. What the bundled compose file is (and is not)

`docker-compose.yml` is a **single-host** deployment: convenient and verified, not highly available.

- Infrastructure ports are published to the host for development. **Remove the `ports:` of postgres, redis, kafka, zookeeper and rabbitmq** in production and rely on the compose network.
- Postgres TLS uses a self-signed certificate generated at first start. Use your CA's certificate and `sslmode=verify-full`.
- One Kafka broker, one ZooKeeper, one RabbitMQ: no replication. For real availability use managed services (set `KAFKA_SSL=true` + SASL, `REDIS_*`, `RABBITMQ_URL` accordingly).
- Put a TLS-terminating reverse proxy / load balancer in front of `app:3000` (`trustProxy` is on, so client IPs are honoured for rate limiting).
- Image size is ~1.1 GB (target was 200 MB): ~170 MB is OpenTelemetry packages nothing imports — removing them is the next-largest saving.

## 7. Moving to a new repository

1. `git status` clean on `main`; CI green (lint, unit ≥ 80 % coverage, alert-rule check, integration + e2e).
2. Push to the new remote with full history (`git remote add new-origin <url> && git push new-origin --all --tags`), or use your Git
   host's transfer/import feature if moving an existing repo to a new owner.
3. On the new remote: confirm all branches and history are present, enable Actions/CI, and re-create any repository secrets — they
   never transfer automatically.
4. Rotate every credential that ever appeared in the repository history (the old `SERVICE_API_KEY` was committed in `.env.example`).

## 8. Known limitations

See [docs/security.md](docs/security.md) (known gaps) and [docs/consent-and-digests.md](docs/consent-and-digests.md). Notably: no device-token registry (real
FCM push is not functional; mock mode is), WhatsApp templates are always sent as `en_IN`, per-IP (not per-user) rate limiting, and
Nigerian-language translations are drafts awaiting native-speaker review.
