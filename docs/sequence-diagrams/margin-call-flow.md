<!-- docs/sequence-diagrams/margin-call-flow.md -->

# Margin Call Notification Flow

## Sequence Diagram

```mermaid
sequenceDiagram
    participant ME as Margin Engine
    participant API as API Gateway
    participant K as Kafka (critical)
    participant ENG as Engine
    participant DND as DND Service
    participant CAP as Freq Cap
    participant TPL as Template Engine
    participant RMQ as RabbitMQ
    participant SMS as MSG91/Twilio
    participant DB as PostgreSQL
    participant DLR as DLR Webhook

    ME->>API: POST /api/v1/events (RISK-001, priority=1)
    API->>K: publish to notification-critical topic
    API-->>ME: 202 Accepted (correlationId)

    K->>ENG: consume (< 100ms, dedicated consumer group)
    ENG->>DB: create notification record (CREATED)
    ENG->>ENG: deduplication check (Redis fingerprint)

    ENG->>DND: check DND status
    Note over DND: RISK-001 = TRANSACTIONAL<br/>bypasses DND even if registered
    DND-->>ENG: allowed (TRANSACTIONAL_EXEMPT)

    ENG->>CAP: check frequency caps
    Note over CAP: CRITICAL event<br/>bypasses all caps
    CAP-->>ENG: allowed (CRITICAL_BYPASS)

    ENG->>DB: state transition CREATED→ENRICHED
    ENG->>ENG: regulatory override — SMS+Push mandatory

    ENG->>TPL: render RISK-001-v1 (user locale: hi)
    TPL-->>ENG: rendered SMS + Push + in_app content

    ENG->>RMQ: publish to notifications.sms (priority=10)
    ENG->>RMQ: publish to notifications.push (priority=10)
    ENG->>DB: state transition ENRICHED→ROUTED→QUEUED

    RMQ->>SMS: consume + send via MSG91
    SMS-->>RMQ: delivery receipt

    alt MSG91 fails
        SMS-->>RMQ: 503 error
        RMQ->>ENG: circuit breaker records failure
        Note over ENG: After 5 failures → OPEN
        ENG->>SMS: failover to Twilio
    end

    DLR->>API: POST /webhooks/dlr (DELIVRD)
    API->>DB: state transition SENT→DELIVERED
    DB->>ENG: analytics counter incremented

    Note over ME,DLR: Total latency target: < 10 seconds
```

## Key Design Decisions

**Why dedicated Kafka consumer group for CRITICAL events?**
The `notification-critical` topic uses a dedicated consumer group (`notification-critical-cg`) with dedicated instances. This means margin calls are never queued behind price alerts. This directly addresses the Robinhood failure mode (Case Study C4) where priority inversion caused margin calls to be delayed behind market updates.

**Why DND bypass for RISK-001?**
RISK-001 is classified as TRANSACTIONAL (SEBI mandate). TRAI DND regulations exempt transactional messages. The bypass is logged in the audit trail for compliance review.

**Why SMS + Push simultaneously (not sequentially)?**
The Saga pattern for RISK-001 uses parallel delivery, not sequential fallback. Both channels are dispatched simultaneously. If SMS fails, it retries independently without waiting for Push to complete. This ensures the user receives the notification on at least one channel within the 10-second window.
