<!-- docs/adr/003-redis-fail-open-strategy.md -->

# ADR-003: Redis Failure — Fail Open with Local Approximation

**Date:** 2025-03  
**Status:** Accepted

## Context

If Redis becomes unavailable, frequency capping cannot function. Two strategies exist: fail closed (block all non-critical notifications until Redis recovers) or fail open (allow notifications through with approximate counting).

## Decision

Fail open with local in-memory LRU approximation during Redis outage.

## Consequences

**Positive:**

- Critical notifications are never blocked by Redis failure
- Users continue to receive notifications during infrastructure issues
- No thundering herd when Redis recovers (no accumulated backlog)

**Negative:**

- Up to one extra notification per user per event type during outage window
- Local counters are per-instance and not shared — counts are approximate

**Mitigation:**

- Short TTL on local cache (30 seconds) limits over-notification window
- All decisions made under degraded mode are logged with `degraded_mode=true` label
- Prometheus alert fires when Redis is unavailable

## Alternatives considered

Fail closed — rejected because it would block SEBI-mandated margin call notifications during Redis outage, creating regulatory liability.
