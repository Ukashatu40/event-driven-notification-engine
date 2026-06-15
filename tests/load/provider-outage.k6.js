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
var USER_IDS_RAW =
  __ENV.USER_IDS ||
  '0f92ba3b-8f5b-424b-a101-cbbf5525cb31,8cb5468f-8c88-491e-b7bb-08b372073c63,36d89330-b487-4835-a231-197dc9834cae,23734af0-3353-4bf9-81dd-980f62db8d17,d63684c0-347e-4acd-a200-51448347bfd7,a4ed57c0-3660-4bbf-a4ce-6cc29e68fc8f,da99a4ec-8294-4e35-9b0a-9fbf07d9b169,f889e610-b739-457c-a454-b6d94ba5d6d4,443b0019-e51b-464a-b060-cb7158ac3838,43fc57a3-0aa0-4c65-b22b-e940d5e41704';
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

  // Fixed: health endpoint is at /api/health not /health
  var healthRes = http.get(BASE_URL + '/api/health');
  check(healthRes, {
    'health responsive': function (r) {
      return r.status === 200;
    },
  });

  sleep(0.2);
}
