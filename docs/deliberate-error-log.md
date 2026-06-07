# Document Error Log

Five deliberate errors identified in the project specification (Section A13).

---

## Error 1 — Retry Formula Off-By-One (Section A9.1)

**Location:** Section A9.1, Exponential Backoff Formula

### As Written in the Specification

```text
retryDelay = min(baseDelay * 2^attempt + randomJitter(0, 1000), maxDelay)
// Attempt 1: ~1-2 seconds
```

### Why It Is Wrong

With:

```text
baseDelay = 1000ms
attempt = 1
```

The formula evaluates to:

```text
1000 * 2^1 = 2000ms
```

This produces approximately **2 seconds**, not the **1–2 seconds** indicated in the comment.

As a result, the first retry skips the intended base delay entirely.

### Correct Implementation

```text
retryDelay = min(baseDelay * 2^(attempt-1) + randomJitter(0, 1000), maxDelay)

// Attempt 1: 1000 + jitter ≈ 1-2 seconds ✓
// Attempt 2: 2000 + jitter ≈ 2-3 seconds ✓
```

### Implementation

`src/shared/utils/retry.util.ts` uses the corrected exponent:

```text
attempt - 1
```

---

## Error 2 — Invalid PRIMARY KEY Expression in `user_preferences` (Section A5.2)

**Location:** Section A5.2, `user_preferences` DDL

### As Written in the Specification

```sql
PRIMARY KEY (user_id, event_category, COALESCE(event_type, '*'), channel)
```

### Why It Is Wrong

PostgreSQL does not allow expressions or function calls inside a `PRIMARY KEY` declaration.

The expression:

```sql
COALESCE(event_type, '*')
```

is not valid in a primary key definition and causes the DDL to fail.

Example error:

```text
ERROR: syntax error at or near "("
```

### Correct Implementation

Option 1: Use a sentinel value with a non-null column.

```sql
event_type VARCHAR(10) NOT NULL DEFAULT '*',

PRIMARY KEY (
  user_id,
  event_category,
  event_type,
  channel
)
```

Option 2: Use a generated column or unique constraint.

Our implementation uses a Prisma composite unique index.

### Implementation

```prisma
@@unique([userId, eventCategory, channel])
```

---

## Error 3 — MKTX-003 Urgency vs Channel Contradiction (Section A2.5)

**Location:** Section A2.5, Category 4 Market Events Table

### As Written in the Specification

```text
MKTX-003 (Market Open/Close)
Urgency: LOW
Channel: Push only
```

### Why It Is Wrong

Push notifications are designed for high-attention, time-sensitive communication.

Assigning a **LOW** urgency event exclusively to Push contradicts:

- Channel-selection principles
- User experience best practices
- Cost-optimization goals
- Priority 4 routing logic defined in Section A3.2

Low-urgency notifications should favor less disruptive channels such as:

- In-app notifications
- Email digests

### Correct Implementation

Either:

- Upgrade urgency to `MEDIUM`, or
- Change the default channel to `in_app` with email digest fallback

### Implementation

The routing engine applies:

```text
LOW urgency
    ↓
Primary: in_app
Secondary: email digest
```

---

## Error 4 — Frequency Cap Dimensions Are Mathematically Inconsistent (Section A6.2)

**Location:** Section A6.2, Frequency Capping Engine Table

### As Written in the Specification

```text
Global per-user daily cap: 12 notifications/day
Per-category cap: 3 notifications/hour
```

### Why It Is Wrong

The system defines five event categories:

```text
TXNX
RISK
SIPX
MKTX
REGX
```

Maximum theoretical notifications:

```text
5 categories × 3/hour × 6.25 market hours
= 93.75 notifications/day
```

The global daily cap of **12/day** triggers long before the per-category cap becomes meaningful.

Therefore, the category-level cap is effectively unreachable in normal operation.

### Correct Implementation

Evaluate limits from most specific to least specific:

1. Cooldown (per event type, 15 minutes)
2. Per-category hourly cap (3/hour)
3. Per-channel daily cap
   - SMS = 5/day
   - Push = 8/day
   - Email = 3/day

4. Global daily cap (12/day)

### Implementation

`src/compliance/frequency-cap/frequency-cap.service.ts`

Evaluation order follows the corrected sequence above.

---

## Error 5 — REGX-005 Retry Budget Cannot Meet 24-Hour SLA (Section A2.6 + A9.1)

**Location:** Section A2.6 (REGX-005) and Section A9.1 (Retry Policy)

### As Written in the Specification

```text
REGX-005 urgency: LOW
Maximum latency: < 24 hours

LOW priority retry policy:
- Max retries: 2
- Base delay: 30 seconds
- Max delay: 2 hours
```

### Why It Is Wrong

Failure timeline:

```text
Attempt 1 fails
    ↓
Retry after ~30 seconds

Attempt 2 fails
    ↓
Retry after ~60 seconds

Retry budget exhausted
    ↓
Moved to DLQ
```

Total elapsed time:

```text
≈ 90 seconds
```

The notification reaches the Dead Letter Queue in less than two minutes and never approaches the stated **24-hour SLA**.

Therefore, the SLA cannot be achieved with the configured retry budget.

### Correct Implementation

Either:

- Promote REGX-005 to `MEDIUM` priority, or
- Increase retry count and retry delay limits for LOW-priority events

### Implementation

The routing engine promotes:

```text
REGX-005 → MEDIUM priority
```

This aligns retry behavior with the required delivery SLA.

---

## Summary

| Error   | Area            | Resolution                                         |
| ------- | --------------- | -------------------------------------------------- |
| Error 1 | Retry Backoff   | Use `attempt - 1` exponent                         |
| Error 2 | Database Schema | Replace invalid PK expression                      |
| Error 3 | Routing Logic   | Align urgency with channel strategy                |
| Error 4 | Frequency Caps  | Evaluate caps from most specific to least specific |
| Error 5 | Retry SLA       | Promote REGX-005 or extend retry budget            |

All five specification inconsistencies have been identified, documented, and corrected in the implementation.
