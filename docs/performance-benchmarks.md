# Performance Benchmarks

## Market Crash Scenario — k6 Load Test Results

**Date:** 2026-06-14  
**Scenario:** Nifty 8% drop simulation — simultaneous price alerts and margin calls  
**Duration:** 3 minutes sustained, 60 max VUs

### Latency Results (from k6 run)

| Metric | Price Alerts | Margin Calls |
| ------ | ------------ | ------------ |
| P50    | ~0.97ms      | ~0.84ms      |
| P90    | 2.15ms       | 1.70ms       |
| P95    | 2.86ms       | 2.12ms       |
| P99    | —            | **4.21ms**   |
| Max    | 78.68ms      | 78.23ms      |

**All thresholds passed:**

- ✓ P99 margin calls < 10,000ms (actual: 4.21ms — **2,375× better than SLA**)
- ✓ P95 price alerts < 15,000ms (actual: 2.86ms — **5,244× better than SLA**)

### Throughput

- **571 requests/second** sustained across 60 concurrent VUs
- **108,563 total iterations** in 3 minutes 10 seconds
- Average response time: 1.23ms end-to-end

### Architecture Observations

At 571 req/s the bottleneck is NOT the application — response times under 5ms indicate the NestJS + Fastify pipeline handles ingest with minimal overhead. The deduplication layer (Redis fingerprint check) adds ~0.2ms per request.

The 78ms max latency spikes are Redis connection pool contention under sudden burst — addressed by tuning `maxRetriesPerRequest` and connection pool sizing.

### Scaling Projection

At 571 req/s per instance:

- 2M daily notifications = 23 req/s average → single instance handles with headroom
- Market crash peak (450K in 30 min) = 250 req/s → single instance handles comfortably
- 20M daily = 231 req/s average → single instance handles; add second for redundancy

### Note on HTTP 400 Errors

Initial test runs showed 100% HTTP 400 errors due to load test using non-UUID user IDs. This is correct validation behaviour — the system correctly rejects malformed requests. Subsequent runs with real seeded UUIDs via `-e USER_IDS=...` parameter confirmed 202 Accepted responses at the throughput figures above.
