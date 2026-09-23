# Deploying a free, live demo (backend and frontend on separate hosts)

This is a **different** deployment target from [DEPLOYMENT.md](DEPLOYMENT.md), which stays the right guide for a real/on-prem Docker
Compose deployment. This one is for a portfolio: a genuinely live, free instance, with Postgres/Redis/Kafka/RabbitMQ each on the
specific provider that is actually free for it, the backend on Render, and the frontend on Vercel.

**I cannot create these accounts for you** — sign-up is something only you can do. Everything below is written so your part is
"click sign-up, copy a value, paste it," not figuring out configuration.

## What a visitor experiences (read this before you link it anywhere)

Render's free web service sleeps after 15 minutes with no traffic and takes about a minute to wake on the next request. The first
person to open the demo after a quiet spell watches a slow load; after that it's normal speed until it idles out again. An event
sent while it's asleep sits in Kafka/RabbitMQ and is processed the moment it wakes — nothing is lost, it's just not instant. Say
this plainly in your README rather than let someone discover it — it reads as "I understand free-tier trade-offs," not as a flaw.

## 1. Create the five accounts, in this order

### Postgres — [Neon](https://neon.tech)
1. Sign up (no card). Create a project.
2. Project → **Connection Details** → select **Pooled connection** → copy the full URL. It already ends `?sslmode=require`.
3. That's your `DATABASE_URL`.

### Redis — [Upstash](https://upstash.com) (Redis database)
1. Sign up. Create a Redis database (any region close to where you'll put Render).
2. Database → **Details** tab → copy the **Endpoint** and **Password**. Use the TCP endpoint, not the REST URL — this app speaks
   the Redis protocol via `ioredis`, not Upstash's HTTP API.
3. `REDIS_HOST` = endpoint, `REDIS_PORT` = 6379, `REDIS_PASSWORD` = the password, `REDIS_TLS` = `true`.

### Kafka — [Upstash](https://upstash.com) (Kafka cluster, same account)
1. Create a Kafka cluster.
2. Cluster → **Topics** → create these seven (this app never auto-creates topics, on purpose — `allowAutoTopicCreation: false` in
   `src/config/kafka.config.ts`):
   `notification-events`, `notification-critical`, `notification-routing`, `notification-delivery`, `notification-status`,
   `notification-analytics`, `notification-dlq`.
3. Cluster → **Details** → **Credentials** tab → copy the bootstrap endpoint, username and password.
4. `KAFKA_BROKERS` = the endpoint (`host:9092`), `KAFKA_SSL` = `true`, `KAFKA_SASL_USERNAME` / `KAFKA_SASL_PASSWORD` = from that tab.

### RabbitMQ — [CloudAMQP](https://cloudamqp.com)
1. Sign up. Create an instance on the **Little Lemur** (free) plan.
2. Instance page → copy the **AMQP URL** (starts `amqps://`, already has credentials and the vhost baked in).
3. That whole string is your `RABBITMQ_URL`.

### Email — you already have this (Brevo, from earlier)
Reuse the same `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`.

## 2. Deploy the backend — [Render](https://render.com)

1. New → **Web Service** → connect this GitHub repo → **Environment: Docker** (it will use the root `Dockerfile`).
2. Plan: **Free**.
3. Environment → add every variable from `.env.example` **and** every variable in `.env.cloud.example` (the cloud file's values
   *replace* the matching local ones — e.g. its `DATABASE_URL` replaces `.env.example`'s `DB_HOST`/`DB_PORT`/etc. entirely). Include
   `NODE_ENV=production` and `RUN_MIGRATIONS_ON_BOOT=true`. Generate fresh secrets for `JWT_SECRET`, `JWT_REFRESH_SECRET`,
   `PII_ENCRYPTION_KEY`, `PII_HASH_KEY`, `WEBHOOK_SIGNATURE_SECRET`, and each role's `*_API_KEY` — reuse the local dev script:
   `scripts/bash/deploy/preflight.sh` checks exactly this set, run it against a local file with the same values before pasting them
   in, to catch a weak/placeholder/reused secret before it's live.
4. Deploy. First boot runs `prisma migrate deploy` (see `docker/entrypoint.sh`) before the app starts — watch the deploy log for
   `No pending migrations to apply` or the list of migrations it applied.
5. Once live, note the Render URL (`https://<something>.onrender.com`) — the frontend needs it next.

## 3. Deploy the frontend — [Vercel](https://vercel.com)

1. Import the same repo, **root directory: `frontend`**.
2. Framework preset: Vite. Build command / output directory are auto-detected from `frontend/package.json`.
3. Environment variable: `VITE_API_URL` = the Render URL from step 2.5. This is read at **build time** (`frontend/vite.config.ts`
   already wires it into the production CSP's `connect-src` — no other change needed).
4. Deploy. Note the Vercel URL.
5. Back on Render: set `CORS_ORIGINS` to that Vercel URL (comma-separate more than one if you add a custom domain later), and
   redeploy the backend so the new value takes effect.

## 4. Give yourself a real login

The bulk-seeded users have fake test contact details (`…@wealthbridge-test.in`, `+9190000000xx`) — nothing will actually arrive.
Run this once, against the *cloud* database, from your own machine (point `DATABASE_URL`/`PII_*` at the cloud values locally, or
run it as a one-off Render shell command):

```bash
npm run seed:me -- --email=you@yourrealaddress.com --name="Your Name"
```

Then sign in at `https://<your-vercel-url>/portal/login` with that email — the OTP arrives via the real Brevo credentials.

## 5. Smoke test the live deployment

The same checks run locally all session, against the real URLs this time:

```bash
curl https://<render-url>/health              # every component "up"
# sign in at https://<vercel-url>/login as ADMIN, send a RISK-001 event, watch it reach DELIVERED on the Live feed
# sign in at https://<vercel-url>/portal/login with your seeded email, confirm the inbox/preferences/consent pages load
```

## Free-tier ceilings (fine for a demo, not for real traffic)

Neon: 0.5 GB storage, 100 compute-hours/month. Upstash Redis: 500K commands/month. Upstash Kafka: a free-tier message cap (check
the current number on their pricing page — it changes). CloudAMQP: 10,000 queued messages, 100 queues. None of these are close to a
concern for someone clicking around a portfolio demo; they would need upgrading for real production traffic.
