// src/analytics/metrics.service.ts
// Re-exports PrometheusService under the analytics domain alias.
// Keeps analytics module self-contained per the spec structure.
export { PrometheusService as MetricsService } from '../health/prometheus/prometheus.service';
