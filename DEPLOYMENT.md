<!-- DEPLOYMENT.md -->

# Deployment Guide

## Prerequisites

- Docker Engine 24+
- Docker Compose v2.20+
- Node.js 20 LTS (for local development only)
- 4GB RAM minimum (8GB recommended for full stack)

---

## Local Development

### 1. Infrastructure only (recommended for development)

```bash
# Start all infrastructure services
docker compose up postgres redis zookeeper kafka rabbitmq -d

# Wait for services to be healthy
docker compose ps

# Run migrations
npx prisma migrate dev

# Seed database
npm run prisma:seed

# Start app in watch mode
npm run start:dev
```

### 2. Full stack via Docker Compose

```bash
# Copy and configure environment
cp .env.example .env
# Edit .env with your values

# Build and start everything
docker compose up -d

# Check all services are healthy
docker compose ps

# View application logs
docker compose logs app -f

# Run migrations inside container
docker compose exec app npx prisma migrate deploy
```

### 3. Verify the stack is running

```bash
# Health check
curl http://localhost:3000/health

# Readiness probe
curl http://localhost:3000/ready

# Prometheus metrics
curl http://localhost:3000/metrics

# Swagger UI
open http://localhost:3000/api-docs

# RabbitMQ management UI
open http://localhost:15672
# Default: notification_user / <RABBITMQ_PASSWORD from .env>

# Grafana dashboard
open http://localhost:3001
# Default: admin / <GRAFANA_PASSWORD from .env>
```

---

## Environment Variables

All required variables are documented in `.env.example`.

Critical variables that must be set before running:

| Variable                   | Description               | Minimum             |
| -------------------------- | ------------------------- | ------------------- |
| `JWT_SECRET`               | JWT signing key           | 32 characters       |
| `JWT_REFRESH_SECRET`       | Refresh token key         | 32 characters       |
| `DB_PASSWORD`              | PostgreSQL password       | Any strong password |
| `REDIS_PASSWORD`           | Redis AUTH password       | Any strong password |
| `RABBITMQ_PASSWORD`        | RabbitMQ password         | Any strong password |
| `WEBHOOK_SIGNATURE_SECRET` | Provider webhook HMAC key | 16 characters       |

---

## Database Migrations

```bash
# Development — creates migration files
npx prisma migrate dev --name <description>

# Production — applies existing migrations only
npx prisma migrate deploy

# Reset database (DANGER — destroys all data)
npx prisma migrate reset

# View migration status
npx prisma migrate status
```

---

## Production Deployment Checklist

### Security

- [ ] All secrets are set via environment variables — nothing hardcoded
- [ ] `.env` is in `.gitignore` and never committed
- [ ] `NODE_ENV=production` is set
- [ ] JWT secrets are at least 32 characters
- [ ] Redis AUTH is enabled (`--requirepass`)
- [ ] PostgreSQL SSL is enabled for client connections
- [ ] Docker containers run as non-root user (already configured)
- [ ] Resource limits are set in Docker Compose (already configured)

### Infrastructure

- [ ] All health checks pass: `GET /health`
- [ ] Readiness probe passes: `GET /ready`
- [ ] Kafka topics are created (auto-created on first start)
- [ ] RabbitMQ exchanges and queues are provisioned (auto on start)
- [ ] Database migrations are applied: `prisma migrate deploy`
- [ ] Database is seeded with template records: `npm run prisma:seed`

### Observability

- [ ] Prometheus is scraping `/metrics` endpoint
- [ ] Grafana datasource is pointed at Prometheus
- [ ] Alert rules are configured for DLQ depth, circuit breakers, latency
- [ ] Structured logs are flowing (check `docker compose logs app`)
- [ ] Correlation IDs appear in log lines

### Monitoring Alerts to Configure in Grafana

- DLQ depth > 100 for > 5 minutes → CRITICAL
- Any provider circuit breaker OPEN → HIGH
- P99 delivery latency > 30s for CRITICAL events → CRITICAL
- Delivery failure rate > 5% in 10-minute window → HIGH
- Kafka consumer lag > 10,000 messages → HIGH
- DND violations detected (should always be zero) → CRITICAL

---

## Scaling Guide

### Horizontal scaling (add more app instances)

```bash
docker compose up app --scale app=3 -d
```

All instances share Redis state so circuit breakers, frequency caps,
and deduplication work correctly across instances.

### Kafka partition scaling

Increase partitions when consumer lag grows consistently above 10,000:

```bash
docker compose exec kafka \
  kafka-topics --bootstrap-server localhost:9092 \
  --alter --topic notification-events \
  --partitions 12
```

Add consumer instances proportionally (1 instance per partition maximum).

### Redis scaling

For > 10M daily notifications, migrate to Redis Cluster:

- Set `REDIS_CLUSTER=true` in environment
- Set `REDIS_CLUSTER_NODES` with comma-separated `host:port` pairs
- Frequency capping uses atomic INCR which is cluster-safe

### PostgreSQL read replicas

Analytics queries (`GET /analytics/*`) can be routed to read replicas
by setting `DATABASE_REPLICA_URL` in environment. The analytics service
will use this connection for all SELECT operations.

---

## Stopping the Stack

```bash
# Stop all services (preserves data volumes)
docker compose down

# Stop and remove all data (DANGER)
docker compose down -v
```
