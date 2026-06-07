<!-- docs/adr/002-kafka-over-rabbitmq-for-ingestion.md -->

# ADR-002: Kafka for Event Streaming, RabbitMQ for Delivery Routing

**Date:** 2025-03  
**Status:** Accepted

## Context

The system needs two distinct messaging patterns: high-volume event ingestion with replay capability, and priority-based delivery routing with per-channel queues.

## Decision

Use Kafka as the primary event bus for ingestion. Use RabbitMQ for delivery routing.

## Consequences

**Kafka for ingestion:**

- Handles 1M+ messages/sec per partition
- Message replay enables reconciliation after provider outages
- Consumer groups allow parallel processing with ordering guarantees per partition
- Immutable log provides the event sourcing audit trail required by SEBI

**RabbitMQ for delivery:**

- Native priority queues (x-max-priority) map directly to notification priority levels
- Dead letter exchanges built-in — no custom DLQ implementation needed
- Per-channel queues with independent prefetch counts allow backpressure per channel
- Routing keys enable flexible channel fan-out
