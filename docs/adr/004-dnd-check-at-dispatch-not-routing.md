<!-- docs/adr/004-dnd-check-at-dispatch.md -->

# ADR-004: DND Check at Dispatch, Not at Routing

**Date:** 2025-03  
**Status:** Accepted

## Context

DND status check can occur at two points: during routing (minutes before send) or immediately before SMS dispatch (milliseconds before send).

## Decision

Check DND status at the last possible moment — immediately before SMS dispatch.

## Consequences

**Positive:**

- Closes the race condition where a user registers for DND between routing and actual send
- This was the primary cause of the ₹20 crore TRAI fine wave (Case Study C3)
- Audit timestamp on DND check proves compliance at exact moment of dispatch

**Negative:**

- Marginally increases dispatch latency (~2ms for Redis cache hit)
- DND-blocked notifications have already consumed routing and template rendering resources

## Reference

TRAI case study (Section C3): stale DND databases and routing-time checks were the root cause of the 12,847 DND violations at WealthBridge.
