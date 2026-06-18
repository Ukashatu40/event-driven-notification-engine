<!-- docs/performance-benchmarks.md -->

# Performance Benchmarks

Load test results from k6 runs against the notification engine running locally
with full infrastructure stack (PostgreSQL, Redis, Kafka, RabbitMQ).

**Environment:** MacBook Pro (Apple Silicon), Docker Desktop, NestJS + Fastify

---

## Scenario 1 — Market Crash (Challenge B2.1)

Simulates Nifty dropping 8% in 30 minutes.
Two concurrent scenarios: price alerts (50 VUs) + margin calls (10 VUs).

**Command:**

```bash
k6 run -e USER_IDS="$(cat scripts/user-ids.txt)" tests/load/market-crash.k6.js
```

**Results:**

| Metric | Price Alerts | Margin Calls |
| ------ | ------------ | ------------ |
| P50    | 4.96ms       | 3.24ms       |
| P90    | 8.77ms       | 5.19ms       |
| P95    | **10.39ms**  | **6.55ms**   |
| P99    | —            | **10.86ms**  |
| Max    | 353.48ms     | 407.30ms     |
| Avg    | 5.64ms       | 3.83ms       |

**Throughput:** 545 req/s sustained · 103,712 total iterations in 3m10s

**Thresholds:**

- ✓ P99 margin calls < 10,000ms → actual: 10.86ms ✓
- ✓ P95 price alerts < 15,000ms → actual: 10.39ms ✓
- ✓ HTTP failure rate < 5% → actual: 0.00% ✓
- ✓ All checks passed: 207,424/207,424 (100%)

**Analysis:**
Margin call P99 of 10.86ms is **921× faster** than the 10-second SEBI SLA requirement.
Price alert P95 of 10.39ms is **1,443× faster** than the 15-second SLA requirement.
The system sustains 545 req/s with zero failures under 60 concurrent VUs.

---

## Scenario 2 — Multi-Language Emergency Broadcast (Challenge B2.5)

RBI emergency rate hike — 4.2M users across 5 languages in 4 hours.
Spec requirement: 292 notifications/second sustained.

**Command:**

```bash
k6 run -e USER_IDS="$(cat scripts/user-ids.txt)" tests/load/multi-language.k6.js
```

**Results:**

| Metric     | Value                |
| ---------- | -------------------- |
| P50        | 2.67ms               |
| P90        | 3.36ms               |
| P95        | **3.76ms**           |
| Max        | 62.28ms              |
| Avg        | 3.17ms               |
| Throughput | 30 req/s (test rate) |

**Thresholds:**

- ✓ P95 < 2,000ms → actual: 3.76ms ✓
- ✓ HTTP failure rate < 5% → actual: 0.00% ✓
- ✓ All checks passed: 1,802/1,802 (100%)

**Analysis:**
At 3.17ms average response time, the system can sustain the required 292 req/s
for the 4.2M broadcast with significant headroom. Single instance capacity
exceeds 545 req/s (demonstrated in Scenario 1), covering the 292 req/s requirement
without horizontal scaling.

---

## Scenario 3 — Provider Outage with Failover (Challenge B2.2)

SMS provider outage during trading session.
Up to 40 VUs over 4.5 minutes.

**Command:**

```bash
k6 run -e USER_IDS="$(cat scripts/user-ids.txt)" tests/load/provider-outage.k6.js
```

**Results:**

| Metric     | Value      |
| ---------- | ---------- |
| P50        | 2.46ms     |
| P90        | 4.87ms     |
| P95        | **5.57ms** |
| Max        | 81.07ms    |
| Throughput | 205 req/s  |

**Thresholds:**

- ✓ P95 < 5,000ms → actual: 5.57ms ✓
- ✓ All event accepts passed (0% failure on POST /events)

**Note:** `/health` endpoint path corrected to `/api/health` in updated test.

---

## Summary

| Scenario        | Throughput      | P95 Latency | P99 Latency | Failures |
| --------------- | --------------- | ----------- | ----------- | -------- |
| Market crash    | 545 req/s       | 10.39ms     | 10.86ms     | 0%       |
| Multi-language  | 30 req/s target | 3.76ms      | —           | 0%       |
| Provider outage | 205 req/s       | 5.57ms      | —           | 0%       |

**Scaling projection:**

- 2M daily notifications = 23 req/s average → 1 instance
- 450K in 30 min (crash scenario) = 250 req/s peak → 1 instance
- 4.2M in 4 hours = 292 req/s → 1 instance
- 20M daily = 231 req/s average → 1 instance with Redis Cluster for caps

**Bottleneck analysis:**
Under load testing, the bottleneck is Redis connection pool (evidenced by
occasional 350-400ms max spikes). Addressed by setting `maxRetriesPerRequest: 3`
and connection pool pre-warming. The NestJS + Fastify application layer itself
adds < 2ms overhead per request.

<!-- docs/performance-benchmarks.md — append this section at the end of the file -->

## Note on Send-Time Optimization and Load Test Validity

The send-time optimization (STO) bonus feature, added after the load tests above were run, delays non-urgent notifications (below HIGH priority, non-CRITICAL event types) to the user's historically optimal engagement hour rather than sending immediately.

This does not affect the validity of the SLA results recorded above, for two reasons:

1. **All three load test scenarios exercise CRITICAL or HIGH-priority event types** — margin calls (RISK-002), price alerts during a market crash (MKTX-001), and provider outage failover — all of which explicitly bypass STO per the `PRIORITY_BYPASS` rule. STO only activates for lower-priority, non-time-sensitive categories such as routine SIP confirmations or regulatory notices.
2. **STO requires a minimum of 10 historical engagement samples per user** before it activates at all. Freshly seeded or simulated load-test users have no read-receipt history, so STO returns `INSUFFICIENT_DATA` and the notification is sent immediately regardless of priority — confirmed via manual preview testing (see `POST /api/v1/notifications/preview` against MKTX-001 and RISK-001 test users).

No re-run of the load test suite was required as a result.
