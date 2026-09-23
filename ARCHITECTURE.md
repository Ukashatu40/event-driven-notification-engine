# Architecture Documentation

## System Context (C4 Level 1)

```mermaid
flowchart LR

    TE[Trading Engine]
    RE[Risk Engine]
    MD[Market Data]
    SIP[SIP Engine]
    COMP[Compliance]

    NE[Notification Engine<br/>This System]

    U[Users]

    TE --> NE
    RE --> NE
    MD --> NE
    SIP --> NE
    COMP --> NE

    NE --> U
```

---

## Container Diagram (C4 Level 2)

```mermaid
flowchart TB

    subgraph NotificationEngine["Notification Engine"]

        API["API Layer<br/>Fastify<br/>Port 3000"]

        KAFKA["Kafka<br/>6 Topics"]

        WORKERS["Processing Workers<br/><br/>Enrichment<br/>Routing Engine<br/>Template Engine<br/>Compliance"]

        POSTGRES["PostgreSQL<br/>Primary Store"]

        REDIS["Redis<br/>Cache + State"]

        RABBIT["RabbitMQ<br/>5 Channel Queues"]

        DELIVERY["Delivery Workers<br/><br/>SMS<br/>Email<br/>Push<br/>WhatsApp<br/>In-App"]

        PROM["Prometheus<br/>Metrics"]

        GRAF["Grafana<br/>Dashboards"]

        API --> KAFKA
        KAFKA --> WORKERS

        WORKERS --> RABBIT
        RABBIT --> DELIVERY

        GRAF --> PROM

    end
```

---

## Notification Pipeline (Sequence)

```mermaid
sequenceDiagram

    participant Producer
    participant API
    participant Kafka
    participant Engine
    participant RabbitMQ
    participant Provider

    Producer->>API: POST /events

    API->>Kafka: publish

    API-->>Producer: 202 Accept

    Kafka->>Engine: consume

    Note over Engine:
      dedup check
      DND check
      freq cap
      quiet hours
      render template

    Engine->>RabbitMQ: publish

    RabbitMQ->>Provider: consume

    Provider->>Provider: send

    Provider-->>RabbitMQ: result

    Provider-->>Engine: DLR webhook

    Engine->>Engine: update state
```

---

## Kafka Topics

| Topic                  | Partitions | Retention | Consumer Groups | Purpose                 |
| ---------------------- | ---------- | --------- | --------------- | ----------------------- |
| notification-events    | 6          | 7 days    | standard-cg     | General events          |
| notification-critical  | 3          | 7 days    | critical-cg     | CRITICAL priority only  |
| notification-routing   | 6          | 7 days    | routing-cg      | Post-enrichment routing |
| notification-delivery  | 6          | 7 days    | delivery-cg     | Delivery status updates |
| notification-status    | 6          | 7 days    | status-cg       | State transitions       |
| notification-analytics | 6          | 30 days   | analytics-cg    | Analytics aggregation   |
| notification-dlq       | 3          | 90 days   | dlq-cg          | Dead letters            |

> Critical topic has 3 partitions (not 6). Smaller partition count means fewer rebalances during high-frequency margin call scenarios.

---

## RabbitMQ Topology

```text
Exchange: notifications (topic)

├── notifications.sms
│   └── priority=10, DLX → notifications.dlx

├── notifications.email
│   └── priority=10, DLX → notifications.dlx

├── notifications.push
│   └── priority=10, DLX → notifications.dlx

├── notifications.whatsapp
│   └── priority=10, DLX → notifications.dlx

└── notifications.in_app
    └── priority=10, DLX → notifications.dlx

Exchange: notifications.dlx (fanout)

└── notifications.*.dlq
    └── all dead letters
```

### Message Priority Mapping

| Business Priority | RabbitMQ Priority |
| ----------------- | ----------------- |
| CRITICAL (1)      | 10                |
| HIGH (2)          | 7                 |
| MEDIUM (3)        | 5                 |
| LOW (5)           | 2                 |

---

## Redis Key Structure

### Frequency Caps

```text
notif:cap:{userId}:global:daily              TTL: 86400s
notif:cap:{userId}:channel:{ch}:daily        TTL: 86400s
notif:cap:{userId}:category:{cat}:hourly     TTL: 3600s
notif:cap:{userId}:type:{type}:cooldown      TTL: 900s
```

### Deduplication

```text
notif:dedup:{sha256fingerprint}              TTL: 300s
notif:idempotency:{key}                      TTL: 86400s
```

### Circuit Breakers

```text
cb:{provider}:state                          no TTL
cb:{provider}:failures                       TTL: 60s (sliding window)
cb:{provider}:last_attempt                   no TTL
```

### Preferences

```text
user:{userId}:prefs                          TTL: 3600s
```

### DND Cache

```text
dnd:{phoneNumber}                            TTL: 86400s
```

### Retry Queue

```text
notif:retry:queue:{priority}                 no TTL
```

### Quiet Hours Queue

```text
notif:quiet:{userId}                         no TTL
```

---

## Routing Scoring Algorithm

### Formula

```text
Score =
(regulatory × 1000) +
(preference × 400) +
(deliveryRate × 300) +
(costEfficiency × 200)
```

Where:

```text
regulatory     = 1 if CRITICAL event, 0 otherwise

preference     = 1 if channel matches user preference
                 0.5 if default channel

deliveryRate   = historical delivery rate (0-1)

costEfficiency = 1 - (channelCostPaisa / maxCostPaisa)
```

### Example — RISK-001 Margin Call Routing

```text
SMS:
(1000) + (400) + (0.97 × 300) + (0.93 × 200)
= 1877

Push:
(1000) + (400) + (0.70 × 300) + (1.00 × 200)
= 1810

Email:
(1000) + (200) + (0.90 × 300) + (0.99 × 200)
= 1668
```

Both SMS and Push are selected because regulatory requirements mandate both channels.

---

## Database Schema Notes

The `notifications` table is partitioned by `created_at` (monthly).

### Key Indexes

- `(user_id, status, channel)` — user notification queries
- `(status)` WHERE IN ('QUEUED', 'RETRYING') — worker polling
- `BRIN(created_at)` — time-range analytics scans
- `(event_type, created_at)` — analytics aggregations
- `(correlation_id)` — distributed trace lookups

### Audit Trail

The `notification_state_log` table is append-only.

It is never updated and never deleted.

This serves as the immutable audit trail required by SEBI and TRAI regulations.

---

## Entity-Relationship Diagram

```mermaid
erDiagram
    users {
        UUID id PK
        VARCHAR name
        VARCHAR phone
        VARCHAR email
        VARCHAR language
        VARCHAR timezone
        VARCHAR dnd_status
        VARCHAR account_type
        VARCHAR risk_profile
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
    }

    notifications {
        UUID id PK
        VARCHAR event_type
        VARCHAR event_id
        UUID user_id FK
        VARCHAR channel
        INTEGER priority
        VARCHAR status
        VARCHAR template_id
        INTEGER template_version
        JSONB personalisation_data
        JSONB rendered_content
        VARCHAR provider
        VARCHAR external_id
        INTEGER delivery_attempts
        INTEGER max_retries
        TIMESTAMPTZ next_retry_at
        TIMESTAMPTZ delivered_at
        TIMESTAMPTZ read_at
        TEXT failed_reason
        INTEGER cost_paisa
        JSONB metadata
        UUID correlation_id
        VARCHAR idempotency_key
        BOOLEAN dnd_checked
        TIMESTAMPTZ dnd_check_timestamp
        VARCHAR dnd_result
        VARCHAR classification
        BOOLEAN regulatory_override
        BOOLEAN frequency_cap_checked
        VARCHAR frequency_cap_result
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
    }

    notification_state_log {
        BIGINT id PK
        UUID notification_id FK
        VARCHAR from_status
        VARCHAR to_status
        VARCHAR actor
        JSONB metadata
        TIMESTAMPTZ created_at
    }

    dead_letter_queue {
        UUID id PK
        UUID notification_id FK
        JSONB original_event
        TEXT failure_reason
        INTEGER retry_count
        TEXT last_error
        BOOLEAN resolved
        VARCHAR resolved_by
        TIMESTAMPTZ resolved_at
        VARCHAR resolution_action
        TIMESTAMPTZ created_at
    }

    user_preferences {
        UUID user_id FK
        VARCHAR event_category
        VARCHAR event_type
        VARCHAR channel
        BOOLEAN enabled
        BOOLEAN quiet_hours_override
        VARCHAR digest_mode
        INTEGER priority_override
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
    }

    consent_records {
        UUID id PK
        UUID user_id FK
        VARCHAR channel
        VARCHAR consent_type
        BOOLEAN granted
        VARCHAR ip_address
        TEXT consent_text
        TIMESTAMPTZ created_at
    }

    delivery_attempts {
        UUID id PK
        UUID notification_id FK
        VARCHAR channel
        VARCHAR provider
        INTEGER attempt_number
        VARCHAR status
        INTEGER response_code
        TEXT response_body
        INTEGER latency_ms
        TIMESTAMPTZ attempted_at
    }

    provider_health {
        UUID id PK
        VARCHAR provider
        VARCHAR channel
        VARCHAR circuit_state
        INTEGER failure_count
        INTEGER success_count
        TIMESTAMPTZ last_checked
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
    }

    templates {
        UUID id PK
        VARCHAR template_id
        VARCHAR event_type
        INTEGER version
        JSONB channels
        JSONB localisation
        BOOLEAN is_active
        TIMESTAMPTZ created_at
        TIMESTAMPTZ updated_at
    }

    users ||--o{ notifications : "receives"
    users ||--o{ user_preferences : "configures"
    users ||--o{ consent_records : "grants"
    notifications ||--o{ notification_state_log : "transitions"
    notifications ||--o{ delivery_attempts : "records"
    notifications ||--o| dead_letter_queue : "may_enter"
```
