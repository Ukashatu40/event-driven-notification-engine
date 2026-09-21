// src/api/routes/index.ts
//
// The HTTP surface in one place (paths are relative to the global `/api` prefix).
// Controllers declare their own routes; this table is the reference used by
// tests and tooling, and tests/unit/api/rbac-policy.spec.ts guarantees every
// one of them is either public or role-protected.
export const API_ROUTES = {
  auth: { login: 'POST /v1/auth/login', refresh: 'POST /v1/auth/refresh' },
  events: { ingest: 'POST /v1/events' },
  notifications: {
    get: 'GET /v1/notifications/:notificationId',
    listForUser: 'GET /v1/users/:userId/notifications',
    markRead: 'PATCH /v1/notifications/:notificationId/read',
    preview: 'POST /v1/notifications/preview',
    eraseUserData: 'DELETE /v1/users/:userId/data',
  },
  preferences: {
    get: 'GET /v1/users/:userId/preferences',
    update: 'PUT /v1/users/:userId/preferences',
  },
  dlq: { list: 'GET /v1/dlq', resolve: 'PATCH /v1/dlq/:dlqId/resolve' },
  analytics: {
    deliveryRates: 'GET /v1/analytics/delivery-rates',
    channelPerformance: 'GET /v1/analytics/channel-performance',
    optOutTrends: 'GET /v1/analytics/opt-out-trends',
    realtime: 'GET /v1/analytics/realtime',
  },
  webhooks: {
    dlr: 'POST /webhooks/dlr/{sms/msg91|sms/twilio|push/fcm|whatsapp}',
    payments: 'POST /webhooks/payments/{paystack|flutterwave|opay|interswitch}',
  },
  ops: {
    health: 'GET /health',
    ready: 'GET /ready',
    live: 'GET /live',
    metrics: 'GET /metrics',
    docs: 'GET /api-docs',
  },
} as const;
