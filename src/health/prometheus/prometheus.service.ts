// src/health/prometheus/prometheus.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';

@Injectable()
export class PrometheusService implements OnModuleInit {
  private readonly registry: Registry;

  // ── Counters ──────────────────────────────────────────────────────

  readonly notificationEventsReceived: Counter;
  readonly notificationDeliveryTotal: Counter;
  readonly notificationFrequencyCapHits: Counter;
  readonly notificationDndBlocksTotal: Counter;
  readonly notificationRetryTotal: Counter;
  readonly dndViolationsDetected: Counter;

  // ── Histograms ────────────────────────────────────────────────────

  readonly notificationDeliveryLatency: Histogram;
  readonly kafkaMessageProcessingDuration: Histogram;
  readonly templateRenderDuration: Histogram;

  // ── Gauges ────────────────────────────────────────────────────────

  readonly notificationDlqDepth: Gauge;
  readonly kafkaConsumerLag: Gauge;
  readonly deliveryProviderCircuitState: Gauge;
  readonly activeWebSocketConnections: Gauge;
  readonly frequencyCapExhaustionRate: Gauge;

  constructor() {
    this.registry = new Registry();

    // ── Counters ────────────────────────────────────────────────────

    this.notificationEventsReceived = new Counter({
      name: 'notification_events_received_total',
      help: 'Total number of financial events received for processing',
      labelNames: ['event_type', 'priority'],
      registers: [this.registry],
    });

    this.notificationDeliveryTotal = new Counter({
      name: 'notification_delivery_total',
      help: 'Total notification delivery attempts by outcome',
      labelNames: ['channel', 'provider', 'status'],
      registers: [this.registry],
    });

    this.notificationFrequencyCapHits = new Counter({
      name: 'notification_frequency_cap_hits_total',
      help: 'Total notifications blocked by frequency caps',
      labelNames: ['cap_type', 'event_type'],
      registers: [this.registry],
    });

    this.notificationDndBlocksTotal = new Counter({
      name: 'notification_dnd_blocks_total',
      help: 'Total notifications blocked by DND registry',
      labelNames: ['classification'],
      registers: [this.registry],
    });

    this.notificationRetryTotal = new Counter({
      name: 'notification_retry_total',
      help: 'Total notification retry attempts',
      labelNames: ['attempt_number', 'provider', 'priority'],
      registers: [this.registry],
    });

    this.dndViolationsDetected = new Counter({
      name: 'dnd_violations_detected_total',
      help: 'Total DND violations detected — should always be zero in production',
      labelNames: ['channel', 'classification'],
      registers: [this.registry],
    });

    // ── Histograms ──────────────────────────────────────────────────

    this.notificationDeliveryLatency = new Histogram({
      name: 'notification_delivery_latency_seconds',
      help: 'End-to-end notification delivery latency from event ingestion to delivery confirmation',
      labelNames: ['channel', 'priority', 'provider'],
      // Buckets tuned to the SLA targets in the spec:
      // CRITICAL < 10s, HIGH < 30s, MEDIUM < 5min, LOW < 2hrs
      buckets: [0.5, 1, 2, 5, 10, 30, 60, 300, 1800, 7200],
      registers: [this.registry],
    });

    this.kafkaMessageProcessingDuration = new Histogram({
      name: 'kafka_message_processing_duration_seconds',
      help: 'Time taken to process a single Kafka message through the pipeline',
      labelNames: ['topic', 'consumer_group'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 10],
      registers: [this.registry],
    });

    this.templateRenderDuration = new Histogram({
      name: 'template_render_duration_seconds',
      help: 'Time taken to render a notification template',
      labelNames: ['event_type', 'channel', 'locale'],
      buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5],
      registers: [this.registry],
    });

    // ── Gauges ──────────────────────────────────────────────────────

    this.notificationDlqDepth = new Gauge({
      name: 'notification_dlq_depth',
      help: 'Current number of unresolved entries in the dead letter queue',
      registers: [this.registry],
    });

    this.kafkaConsumerLag = new Gauge({
      name: 'kafka_consumer_lag',
      help: 'Current consumer lag per topic partition',
      labelNames: ['topic', 'partition', 'consumer_group'],
      registers: [this.registry],
    });

    this.deliveryProviderCircuitState = new Gauge({
      name: 'delivery_provider_circuit_state',
      help: 'Circuit breaker state per provider: 0=CLOSED (healthy), 1=HALF_OPEN, 2=OPEN (failed)',
      labelNames: ['provider', 'channel'],
      registers: [this.registry],
    });

    this.activeWebSocketConnections = new Gauge({
      name: 'active_websocket_connections',
      help: 'Current number of active WebSocket connections for in-app notifications',
      registers: [this.registry],
    });

    this.frequencyCapExhaustionRate = new Gauge({
      name: 'frequency_cap_exhaustion_rate',
      help: 'Percentage of users who have hit their daily frequency cap (0-1)',
      registers: [this.registry],
    });
  }

  onModuleInit(): void {
    // Collect Node.js default metrics: memory, CPU, event loop lag, GC
    collectDefaultMetrics({
      register: this.registry,
      prefix: 'nodejs_',
    });
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  getRegistry(): Registry {
    return this.registry;
  }

  // ── Convenience helpers ───────────────────────────────────────────

  recordDelivery(
    channel: string,
    provider: string,
    status: 'delivered' | 'failed' | 'bounced',
    latencyMs: number,
    priority: string,
  ): void {
    this.notificationDeliveryTotal.inc({ channel, provider, status });
    this.notificationDeliveryLatency.observe(
      { channel, priority, provider },
      latencyMs / 1000,
    );
  }

  recordCapHit(capType: string, eventType: string): void {
    this.notificationFrequencyCapHits.inc({
      cap_type: capType,
      event_type: eventType,
    });
  }

  recordDndBlock(classification: string): void {
    this.notificationDndBlocksTotal.inc({ classification });
  }

  setCircuitState(
    provider: string,
    channel: string,
    state: 'CLOSED' | 'HALF_OPEN' | 'OPEN',
  ): void {
    const stateValue = state === 'CLOSED' ? 0 : state === 'HALF_OPEN' ? 1 : 2;
    this.deliveryProviderCircuitState.set({ provider, channel }, stateValue);
  }
}
