<!-- docs/database-schema.md -->

# Database Schema

## Overview

The system uses **PostgreSQL 15** with **Prisma ORM**. All tables use UUID primary keys. The `notifications` table is partitioned monthly by `created_at` to improve query performance at scale.

---

## Entity Relationships

```text
users
├── 1 : * notifications
├── 1 : * user_preferences
├── 1 : * consent_records
└── * : * user_segments
        (via user_segment_memberships)

notifications
├── 1 : * notification_state_log
├── 1 : * delivery_attempts
└── 1 : 1 dead_letter_queue
```

---

## Tables

### `users`

Core user identity table.

Contains:

- DND status
- Language preference
- Quiet hours
- Account tier information

Phone and email are unique and are used as delivery addresses and DND lookup keys.

| Column              | Type                               | Description                        |
| ------------------- | ---------------------------------- | ---------------------------------- |
| `id`                | UUID (PK)                          | Auto-generated                     |
| `email`             | VARCHAR(255) UNIQUE                | User email address                 |
| `phone`             | VARCHAR(20) UNIQUE                 | Used for DND lookup                |
| `language`          | ENUM(`EN`, `HI`, `MR`, `TA`, `TE`) | Template localisation              |
| `timezone`          | VARCHAR(50)                        | IANA timezone used for quiet hours |
| `account_type`      | ENUM(`BASIC`, `PREMIUM`, `HNI`)    | Preference defaults differ by tier |
| `dnd_status`        | ENUM                               | `REGISTERED` or `NOT_REGISTERED`   |
| `quiet_hours_start` | VARCHAR(5)                         | Format: `HH:MM`, default `21:00`   |
| `quiet_hours_end`   | VARCHAR(5)                         | Format: `HH:MM`, default `08:00`   |

---

### `notifications`

Central notification table.

- One row per notification per channel.
- Partitioned monthly.

#### Key Indexes

| Index                                             | Purpose                   |
| ------------------------------------------------- | ------------------------- |
| `(user_id, status, channel)`                      | User notification queries |
| `(status)` WHERE status IN (`QUEUED`, `RETRYING`) | Worker polling            |
| `BRIN(created_at)`                                | Time-range analytics      |
| `(correlation_id)`                                | Distributed trace lookup  |

#### Notes

- Monthly partitioning improves scalability.
- BRIN indexes are preferred over B-tree indexes for large time-series datasets.

---

### `notification_state_log`

Append-only audit trail.

- Never updated.
- Never deleted.
- Required for **SEBI** and **TRAI** compliance audits.

Each state transition records:

- Actor
- Timestamp
- Metadata

---

### `delivery_attempts`

Stores information about every delivery attempt.

Captured data includes:

- Provider response
- Error codes
- Latency
- Cost

Used by:

- Circuit breaker logic
- Monitoring
- Analytics

---

### `dead_letter_queue`

Stores notifications that have exhausted all retry attempts.

Supports manual resolution through:

```http
PATCH /api/v1/dlq/:id/resolve
```

Supported actions:

- `retry`
- `discard`

---

### `user_preferences`

Stores per-user channel preferences for each event category.

#### Preference Resolution Hierarchy

```text
System Defaults
        ↓
Segment Defaults
        ↓
User Preferences
        ↓
Regulatory Override
```

Composite unique constraint:

```text
(user_id, event_category, channel)
```

---

### `consent_records`

Immutable TRAI consent audit table.

Every opt-in and opt-out records:

- IP address
- User agent
- Timestamp

Records are never deleted.

---

### `provider_health`

Stores circuit breaker state for each provider.

Updated by the circuit breaker service during:

- Failures
- Recoveries

Read by delivery workers to determine whether a provider should be used.

---

### `templates`

Stores template definitions by:

- Event type
- Version

Supports A/B testing through:

| Column          | Purpose                          |
| --------------- | -------------------------------- |
| `is_ab_variant` | Marks template as an A/B variant |
| `ab_weight`     | Traffic allocation weight        |

---

## Key Design Decisions

### Monthly Partitioning

Partitioning `notifications.created_at` monthly allows analytics queries for recent periods (for example, the last 7 days) to scan only one or two partitions rather than the entire table.

#### Benefit

- Faster analytics
- Lower I/O
- Better scalability

---

### BRIN Indexes

BRIN indexes are used on time-based columns.

Unlike B-tree indexes, BRIN stores only the minimum and maximum values for each block instead of indexing every row.

#### Benefit

- Smaller index size
- Faster scans for time-series workloads
- Lower storage overhead

---

### JSONB Payloads

Notification payloads are stored as `JSONB`.

#### Benefit

New event types can be introduced without requiring database schema migrations.

---

### Immutable State Logging

The architecture separates:

- **Current state** → `notifications`
- **Historical state** → `notification_state_log`

Together, these provide a complete and auditable history of every notification.

---

## Summary

| Table                    | Purpose                                  |
| ------------------------ | ---------------------------------------- |
| `users`                  | User identity and preferences            |
| `notifications`          | Current notification records             |
| `notification_state_log` | Immutable audit history                  |
| `delivery_attempts`      | Delivery metrics and retries             |
| `dead_letter_queue`      | Failed notifications awaiting resolution |
| `user_preferences`       | User channel preferences                 |
| `consent_records`        | Regulatory consent history               |
| `provider_health`        | Circuit breaker state                    |
| `templates`              | Versioned notification templates         |
