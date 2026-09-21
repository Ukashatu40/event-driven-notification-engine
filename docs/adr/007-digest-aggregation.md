# ADR-007: Digests are real notifications, built by a separate flusher

**Status:** Accepted

## Context

The spec asks for digests in three places: a user-chosen hourly/daily mode (Day 5), a morning digest when more than 5 notifications
queue during quiet hours (A6.3), and a digest when 3+ notifications are capped (Appendix B). Digest preferences were stored and
ignored; quiet-hours notifications were released one by one; capped notifications were dropped.

## Decision

* A digest is **one new notification** through the normal pipeline (state machine, RabbitMQ, worker, retry, DLQ) rather than a special
  side channel — so it is observable and recoverable like everything else.
* Held notifications wait in Redis buckets per `(user, source)`; a **`DigestBucketService`** (no dependencies) is used by the engine and a
  **`DigestFlushService`** builds and sends. Splitting them avoids a dependency cycle between the engine and the flusher.
* New states `DIGEST_PENDING` and `DIGESTED`, so the audit trail shows exactly what became part of which digest.
* CRITICAL and regulator-mandated events are never digested.
* Push and in-app only: free, and outside DND/consent scope.
* The "more than 5 overnight" decision uses a queue-depth snapshot taken before the batch is released.

## Consequences

+ Failure-safe: items return to their bucket; nothing is marked `DIGESTED` until the digest is queued.
+ Multi-replica safe (`ZREM` claim, atomic take).
− A held notification is not delivered until its bucket flushes (by design), and the flusher polls every 30 s.
− `capped` below its threshold is discarded rather than carried to the next day.
