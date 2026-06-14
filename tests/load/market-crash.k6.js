// tests/load/market-crash.k6.js
import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  scenarios: {
    price_alerts: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '2m', target: 50 },
        { duration: '30s', target: 0 },
      ],
      tags: { scenario: 'price_alerts' },
      exec: 'runPriceAlert',
    },
    margin_calls: {
      executor: 'constant-vus',
      vus: 10,
      duration: '3m',
      tags: { scenario: 'margin_calls' },
      startTime: '10s',
      exec: 'runMarginCall',
    },
  },
  thresholds: {
    'http_req_duration{scenario:price_alerts}': ['p(95)<15000'],
    'http_req_duration{scenario:margin_calls}': ['p(99)<10000'],
    http_req_failed: ['rate<0.05'],
  },
};

var BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
var SYMBOLS = ['RELIANCE', 'INFY', 'TCS', 'HDFC', 'ICICI'];

// Load USER_IDS from environment variable or use fallback
// Set with: k6 run -e USER_IDS="uuid1,uuid2,uuid3" market-crash.k6.js
var USER_IDS_RAW = __ENV.USER_IDS || '';
var USER_IDS = USER_IDS_RAW.length > 0 ? USER_IDS_RAW.split(',') : [];

function getSymbol() {
  return SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
}

function getUserId() {
  if (USER_IDS.length > 0) {
    return USER_IDS[Math.floor(Math.random() * USER_IDS.length)];
  }
  // Fallback: generate a deterministic UUID-like string for testing
  // Replace this with real UUIDs from: docker compose exec postgres psql ...
  var n = Math.floor(Math.random() * 1000) + 1;
  var padded = String(n).padStart(12, '0');
  return '00000000-0000-0000-0000-' + padded;
}

export function runPriceAlert() {
  var userId = getUserId();
  var symbol = getSymbol();

  var payload = JSON.stringify({
    eventType: 'MKTX-001',
    eventId:
      'EVT-CRASH-' + Date.now() + '-' + Math.floor(Math.random() * 99999),
    sourceSystem: 'market_data_feed',
    timestamp: new Date().toISOString(),
    priority: 2,
    userId: userId,
    payload: {
      symbol: symbol,
      stock_name: symbol,
      target_price: 2000,
      current_price: 1840,
      direction: 'BELOW',
    },
  });

  var res = http.post(BASE_URL + '/api/v1/events', payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '30s',
  });

  check(res, {
    'price alert accepted': function (r) {
      return r.status === 202;
    },
    'has response body': function (r) {
      return r.body !== null && r.body.length > 0;
    },
  });

  sleep(0.1);
}

export function runMarginCall() {
  var userId = getUserId();
  var now = new Date();
  var deadline = new Date(now.getTime() + 3600000);
  var squareOff = new Date(now.getTime() + 7200000);

  var payload = JSON.stringify({
    eventType: 'RISK-001',
    eventId:
      'EVT-MARGIN-' + Date.now() + '-' + Math.floor(Math.random() * 99999),
    sourceSystem: 'margin_engine',
    timestamp: now.toISOString(),
    priority: 1,
    userId: userId,
    payload: {
      shortfall_amount: 125000,
      current_margin: 375000,
      required_margin: 500000,
      deadline: deadline.toISOString(),
      auto_square_off_time: squareOff.toISOString(),
    },
  });

  var res = http.post(BASE_URL + '/api/v1/events', payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '15s',
  });

  check(res, {
    'margin call accepted': function (r) {
      return r.status === 202;
    },
    'margin call fast': function (r) {
      return r.timings.duration < 10000;
    },
  });

  sleep(0.05);
}

export default function () {}
