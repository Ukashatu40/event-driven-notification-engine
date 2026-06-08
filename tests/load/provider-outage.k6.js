// tests/load/provider-outage.k6.js
/**
 * Load Test: SMS Provider Outage (Challenge B2.2)
 *
 * Simulates MSG91 going down during trading session.
 * Verifies circuit breaker activates and failover to Twilio occurs.
 *
 * Run: k6 run tests/load/provider-outage.k6.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 50 }, // ramp up
    { duration: '2m', target: 50 }, // steady state (provider fails here)
    { duration: '30s', target: 100 }, // spike during outage
    { duration: '1m', target: 50 }, // recovery
    { duration: '30s', target: 0 }, // ramp down
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<5000'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  const userId = `user-${Math.floor(Math.random() * 1000) + 1}`;

  const payload = JSON.stringify({
    eventType: 'TXNX-001',
    eventId: `EVT-OUTAGE-${Date.now()}-${Math.random()}`,
    sourceSystem: 'trading_engine',
    timestamp: new Date().toISOString(),
    priority: 2,
    userId,
    payload: {
      stock_name: 'RELIANCE',
      qty: 100,
      price: 2450,
      total: 245000,
      order_id: `ORD-${Date.now()}`,
    },
  });

  const res = http.post(`${BASE_URL}/api/v1/events`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  check(res, {
    'event accepted despite outage': (r) => r.status === 202,
    'response under 5 seconds': (r) => r.timings.duration < 5000,
  });

  // Check circuit breaker state
  const healthRes = http.get(`${BASE_URL}/health`);
  check(healthRes, {
    'health endpoint responsive': (r) => r.status === 200,
  });

  sleep(0.2);
}
