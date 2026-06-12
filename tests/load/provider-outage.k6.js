// tests/load/provider-outage.k6.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 20 },
    { duration: '2m', target: 20 },
    { duration: '30s', target: 40 },
    { duration: '1m', target: 20 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<5000'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  const userId = 'user-' + (Math.floor(Math.random() * 1000) + 1);

  const payload = JSON.stringify({
    eventType: 'TXNX-001',
    eventId:
      'EVT-OUTAGE-' + Date.now() + '-' + Math.floor(Math.random() * 99999),
    sourceSystem: 'trading_engine',
    timestamp: new Date().toISOString(),
    priority: 2,
    userId: userId,
    payload: {
      stock_name: 'RELIANCE',
      symbol: 'RELIANCE',
      qty: 100,
      price: 2450,
      total: 245000,
      order_id: 'ORD-' + Date.now(),
    },
  });

  const res = http.post(BASE_URL + '/api/v1/events', payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  check(res, {
    'event accepted despite outage': function (r) {
      return r.status === 202;
    },
    'response under 5 seconds': function (r) {
      return r.timings.duration < 5000;
    },
  });

  const healthRes = http.get(BASE_URL + '/health');
  check(healthRes, {
    'health endpoint responsive': function (r) {
      return r.status === 200;
    },
  });

  sleep(0.2);
}
