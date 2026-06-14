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

var BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
var USER_IDS_RAW = __ENV.USER_IDS || '';
var USER_IDS = USER_IDS_RAW.length > 0 ? USER_IDS_RAW.split(',') : [];

function getUserId() {
  if (USER_IDS.length > 0) {
    return USER_IDS[Math.floor(Math.random() * USER_IDS.length)];
  }
  var n = Math.floor(Math.random() * 1000) + 1;
  return '00000000-0000-0000-0000-' + String(n).padStart(12, '0');
}

export default function () {
  var userId = getUserId();

  var payload = JSON.stringify({
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

  var res = http.post(BASE_URL + '/api/v1/events', payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  check(res, {
    'event accepted': function (r) {
      return r.status === 202;
    },
    'under 5 seconds': function (r) {
      return r.timings.duration < 5000;
    },
  });

  var healthRes = http.get(BASE_URL + '/health');
  check(healthRes, {
    'health responsive': function (r) {
      return r.status === 200;
    },
  });

  sleep(0.2);
}
