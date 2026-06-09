<!-- docs/sequence-diagrams/frequency-cap-flow.md -->

# Frequency Cap Flow

## Cap Evaluation Order

```mermaid
flowchart TD
    A[Notification arrives] --> B{CRITICAL event?}
    B -->|Yes| C[Bypass all caps\nCreate audit log]
    B -->|No| D{Cooldown active?\n15 min per event type}
    D -->|Yes| E[CAPPED — cooldown]
    D -->|No| F{Category hourly\n> 3/hour?}
    F -->|Yes| G[CAPPED — category hourly]
    F -->|No| H{Channel daily cap\nSMS=5 Push=8 Email=3?}
    H -->|Yes| I[CAPPED — channel daily]
    H -->|No| J{Global daily\n> 12/day?}
    J -->|Yes| K[CAPPED — global daily]
    J -->|No| L[Proceed to delivery]

    C --> L
    E --> M[State: CAPPED\nAnalytics recorded]
    G --> M
    I --> M
    K --> M
```

## Implementation Note

Caps are evaluated most-specific first. This differs from the spec (Section A6.2) which lists global daily first — see Deliberate Error #4 in `docs/deliberate-error-log.md` for the full analysis of why the spec's ordering is mathematically inconsistent.
