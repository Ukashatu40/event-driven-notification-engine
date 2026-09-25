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

Outbound SMTP to Brevo (port 587) intermittently sees a plain TCP "Connection timeout" — confirmed, via Brevo's own delivery log,
that the connection never reaches them at all during these: it's Render's free-tier egress path, not Brevo throttling or a code
bug (the same code, credentials and recipient succeed minutes before and after). The delivery pipeline already retries and
eventually DLQs rather than losing anything, and `nodemailer.provider.ts` uses a 10s connection timeout (not nodemailer's 2-minute
default) specifically so a transient blip gets several fast retries instead of a couple of slow ones. If this proves too frequent
in practice, the next thing worth trying is port 465 (`SMTP_PORT=465`, implicit TLS — the provider already derives `secure` from
the port) as a different egress path, or moving the backend off Render's free tier.

## 1. Create the six accounts, in this order

(Six, not five — Kafka no longer shares Upstash's account now that it needs its own provider; see below.)

### Postgres — [Neon](https://neon.tech)

1. Sign up (no card). Create a project.
2. Project → **Connection Details** → select **Pooled connection** → copy the full URL. It already ends `?sslmode=require`.
3. That's your `DATABASE_URL`.

### Redis — [Upstash](https://upstash.com) (Redis database)

1. Sign up. Create a Redis database (any region close to where you'll put Render).
2. Database → **Details** tab → copy the **Endpoint** and **Password**. Use the TCP endpoint, not the REST URL — this app speaks
   the Redis protocol via `ioredis`, not Upstash's HTTP API.
3. `REDIS_HOST` = endpoint, `REDIS_PORT` = 6379, `REDIS_PASSWORD` = the password, `REDIS_TLS` = `true`.

### Kafka — [Aiven](https://aiven.io) (Apache Kafka, free plan)

Upstash discontinued Upstash Kafka in March 2025 — it's no longer in their console (that's the "no Cluster/Topics" you're seeing).
Aiven's free Kafka plan is the replacement: no card required, standard Kafka protocol (this app talks to it with `kafkajs`, not a
proprietary HTTP API, so it's a genuine drop-in), capped at 5 topics / 2 partitions each — this app only ever creates and uses 3,
comfortably inside that cap.

**Aiven's free-plan Kafka service uses mutual TLS (a client certificate), not SASL** — confirmed empirically: a plain-SSL listener
never expects a SASL handshake at all, and sending one anyway fails with `Request is not valid given the current SASL state`
(`ILLEGAL_SASL_STATE`) even with perfectly correct username/password. So the client certificate below isn't a fallback for when
SASL doesn't work — for this plan, it's the actual mechanism. `KAFKA_SASL_USERNAME`/`KAFKA_SASL_PASSWORD` still exist in this
app's config for a provider whose service genuinely is SASL_SSL (a paid Aiven plan, Confluent Cloud, etc.); the app skips SASL
entirely the moment a client cert is configured, so setting both is never a conflict — just pointless for this plan.

1. Sign up at aiven.io (no card). Create a service → **Apache Kafka** → **Free** plan → any region.
2. `src/config/kafka.config.ts` defines 7 topic names, but `allowAutoTopicCreation: false` means only the ones actually
   subscribed-to or published-to need to exist — that's just 3: **Topics** tab → create `notification-events`,
   `notification-critical`, `notification-dlq`. (The other 4 names — routing/delivery/status/analytics — are reserved for future
   use and nothing reads or writes them today; skip them.)
3. Service page → **Overview** → copy the **Host** and **Port** (this is your bootstrap broker, `host:port`).
4. Same **Overview** page → download all three: **CA Certificate** (`ca.pem`), **Access Certificate** (`service.cert`), **Access
   Key** (`service.key`). Base64 each — genuinely one line, so a web form's text input has nothing to mangle on paste (raw
   multi-line PEM also works, the app detects either form, but base64 is the one that can't go wrong in transit):
   ```bash
   base64 -i ca.pem | tr -d '\n'         # macOS; use base64 -w0 <file> on Linux
   base64 -i service.cert | tr -d '\n'
   base64 -i service.key | tr -d '\n'
   ```
5. **Verify before touching Render at all** — this is the actual live connection, independent of Render or the app:
   ```bash
   openssl s_client -connect <host>:<port> -CAfile ca.pem -cert service.cert -key service.key -brief
   ```
   `Verification: OK` with the connection staying open (exit with Ctrl+C — that's `s_client` waiting for interactive input, not a
   hang) means it works. If you get `Verification: OK` followed immediately by `alert certificate required` (SSL alert 116),
   you're missing `-cert`/`-key` — that alert means the broker demands the client certificate specifically.
6. `KAFKA_BROKERS` = `host:port`, `KAFKA_SSL` = `true`, `KAFKA_SSL_CA` / `KAFKA_SSL_CLIENT_CERT` / `KAFKA_SSL_CLIENT_KEY` = the
   three base64 strings from step 4. Leave `KAFKA_SASL_USERNAME`/`KAFKA_SASL_PASSWORD` unset for this plan.

One free-tier quirk worth knowing: Aiven auto-pauses an idle free Kafka service ("idle shutdown") and also pauses a brand-new one
that sees no traffic in its first few hours ("first-use shutdown") — send a real event through the app soon after setup so it
doesn't idle out before you've verified it works.

### RabbitMQ — [CloudAMQP](https://cloudamqp.com)

1. Sign up. Create an instance on the **Little Lemur** (free) plan.
2. Instance page → copy the **AMQP URL** (starts `amqps://`, already has credentials and the vhost baked in).
3. That whole string is your `RABBITMQ_URL`.

### Email — you already have this (Brevo, from earlier)

Reuse the same `SMTP_HOST` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`.

## 2. Deploy the backend — [Render](https://render.com), via Blueprint

`render.yaml` at the repo root is a **Blueprint** — Render reads it and creates the web service pre-configured (Docker runtime,
free plan, `/health` check), instead of you clicking through "New Web Service" by hand. It also auto-generates the three secrets
nothing else needs to know (`JWT_SECRET`, `JWT_REFRESH_SECRET`, `WEBHOOK_SIGNATURE_SECRET`) and fills every other fixed,
non-secret setting for you — you're only prompted for the genuinely per-deployment values (infra endpoints, the two PII keys, the
three role login keys).

1. Render dashboard → **New +** → **Blueprint** → connect this GitHub repo → it finds `render.yaml` automatically.
2. Render lists every `sync: false` variable and prompts for a value, once, before the first deploy:
   - `DATABASE_URL` (Neon, step above), `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` (Upstash), `KAFKA_BROKERS`/
     `KAFKA_SASL_USERNAME`/`KAFKA_SASL_PASSWORD` (Aiven), `RABBITMQ_URL` (CloudAMQP), `SMTP_HOST`/`SMTP_USER`/`SMTP_PASS`/
     `SMTP_FROM` (Brevo, from earlier) — paste each straight from that provider's dashboard, per the steps above.
   - `CORS_ORIGINS` — you don't have the Vercel URL yet at this point; paste a placeholder (e.g. `http://localhost:5173`) and
     come back to fix it in step 3.5 once the frontend is deployed.
   - `PII_ENCRYPTION_KEY` / `PII_HASH_KEY` — generate with `openssl rand -hex 32` each. These must stay real hex; that's also why
     they're _not_ on the auto-generated list (Render's `generateValue` produces base64, which fails this app's format check).
   - `SERVICE_API_KEY` / `OPERATOR_API_KEY` / `ADMIN_API_KEY` — one login key per ops role; generate each with
     `openssl rand -hex 24` (or similar) and keep a copy — these are what you'll type into `/login` afterward.
   - Run `scripts/bash/deploy/preflight.sh` against a local file with the same values before pasting them in, to catch a
     weak/placeholder/reused secret before it's live — it never prints the values themselves, only what's wrong.
3. Apply the Blueprint. First boot runs `prisma migrate deploy` (`RUN_MIGRATIONS_ON_BOOT=true`, see `docker/entrypoint.sh`) before
   the app starts — watch the deploy log for `No pending migrations to apply` or the list of migrations it applied.
4. Once live, note the Render URL (`https://<something>.onrender.com`) — the frontend needs it next.

Changing `render.yaml` later (a new env var, a plan change) and pushing to `main` updates the existing service in place — it does
not create a second one. To add an env var Render doesn't know about yet, add it to `render.yaml` and push; Render picks it up on
the next deploy.

## 3. Deploy the frontend — [Vercel](https://vercel.com)

1. Import the same repo, **root directory: `frontend`**.
2. Framework preset: Vite. Build command / output directory are auto-detected from `frontend/package.json`.
3. Environment variable: `VITE_API_URL` = the Render URL from step 2.4. This is read at **build time** (`frontend/vite.config.ts`
   already wires it into the production CSP's `connect-src` — no other change needed).
4. Deploy. Note the Vercel URL.
5. Back on Render → your service → **Environment**: replace `CORS_ORIGINS`'s placeholder with that Vercel URL (comma-separate more
   than one if you add a custom domain later), and save — Render redeploys automatically so the new value takes effect.

## 4. Give yourself a real login

The bulk-seeded users have fake test contact details (`…@wealthbridge-test.in`, `+9190000000xx`) — nothing will actually arrive.
Run this once, against the _cloud_ database, from your own machine (point `DATABASE_URL`/`PII_*` at the cloud values locally, or
run it as a one-off Render shell command):

```bash
npm run seed:me -- --email=you@yourrealaddress.com --name="Your Name"
```

Then sign in at `https://<your-vercel-url>/portal/login` with that email — the OTP arrives via the real Brevo credentials.

## 5. Smoke test the live deployment

The same checks run locally all session, against the real URLs this time:

```bash
curl https://notification-engine-92d2.onrender.com/health              # every component "up"
# sign in at https://<vercel-url>/login as ADMIN, send a RISK-001 event, watch it reach DELIVERED on the Live feed
# sign in at https://<vercel-url>/portal/login with your seeded email, confirm the inbox/preferences/consent pages load
```

## Free-tier ceilings (fine for a demo, not for real traffic)

Neon: 0.5 GB storage, 100 compute-hours/month. Upstash Redis: 500K commands/month. Aiven Kafka (free plan): 5 topics / 2 partitions
each, 250 KiB/s in and out, auto-pauses when idle (see the note above). CloudAMQP: 10,000 queued messages, 100 queues. None of these are close to a
concern for someone clicking around a portfolio demo; they would need upgrading for real production traffic.
