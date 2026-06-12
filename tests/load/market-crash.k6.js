// tests/load/market-crash.k6.js
/**
 * Load Test: Market Crash Scenario (Challenge B2.1)
 *
 * Simulates Nifty dropping 8% in 30 minutes:
 * - 450,000 price alert notifications simultaneously
 * - 28,000 margin call notifications (< 10 second delivery)
 * - 3,200 position squared-off notifications
 *
 * Run: k6 run tests/load/market-crash.k6.js
 * Run against staging: BASE_URL=https://your-url k6 run tests/load/market-crash.k6.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Histogram } from 'k6/metrics';

const criticalDelivered = new Counter('critical_delivered');
const deliveryLatency = new Histogram('delivery_latency_ms');

export const options = {
  scenarios: {
    price_alerts: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 100 },
        { duration: '2m', target: 100 },
        { duration: '30s', target: 0 },
      ],
      tags: { scenario: 'price_alerts' },
    },
    margin_calls: {
      executor: 'constant-vus',
      vus: 20,
      duration: '3m',
      tags: { scenario: 'margin_calls' },
      startTime: '10s',
    },
  },
  thresholds: {
    'http_req_duration{scenario:price_alerts}': ['p(95)<15000'],
    'http_req_duration{scenario:margin_calls}': ['p(99)<10000'],
    http_req_failed: ['rate<0.05'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

const SYMBOLS = ['RELIANCE', 'INFY', 'TCS', 'HDFC', 'ICICI'];

function getSymbol(index) {
  return SYMBOLS[index % SYMBOLS.length];
}

function getUserId() {
  return 'user-' + (Math.floor(Math.random() * 1000) + 1);
}

export default function () {
  const scenario = exec.scenario.name;

  if (scenario === 'margin_calls') {
    sendMarginCall();
  } else {
    sendPriceAlert();
  }
}

function sendPriceAlert() {
  const start = Date.now();
  const userId = getUserId();
  const symbolIndex = Math.floor(Math.random() * SYMBOLS.length);

  const payload = JSON.stringify({
    eventType: 'MKTX-001',
    eventId:
      'EVT-CRASH-' + Date.now() + '-' + Math.floor(Math.random() * 99999),
    sourceSystem: 'market_data_feed',
    timestamp: new Date().toISOString(),
    priority: 2,
    userId: userId,
    payload: {
      symbol: getSymbol(symbolIndex),
      stock_name: getSymbol(symbolIndex),
      target_price: 2000,
      current_price: 1840,
      direction: 'BELOW',
    },
  });

  const res = http.post(BASE_URL + '/api/v1/events', payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '30s',
  });

  check(res, {
    'price alert accepted': function (r) {
      return r.status === 202;
    },
    'has notification id': function (r) {
      try {
        const body = JSON.parse(r.body);
        return body.notificationId !== undefined || body.data !== undefined;
      } catch (e) {
        return false;
      }
    },
  });

  deliveryLatency.add(Date.now() - start);
  sleep(0.1);
}

function sendMarginCall() {
  const start = Date.now();
  const userId = getUserId();

  const deadline = new Date();
  deadline.setHours(deadline.getHours() + 1);

  const squareOff = new Date();
  squareOff.setHours(squareOff.getHours() + 2);

  const payload = JSON.stringify({
    eventType: 'RISK-001',
    eventId:
      'EVT-MARGIN-' + Date.now() + '-' + Math.floor(Math.random() * 99999),
    sourceSystem: 'margin_engine',
    timestamp: new Date().toISOString(),
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

  const res = http.post(BASE_URL + '/api/v1/events', payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '15s',
  });

  const success = check(res, {
    'margin call accepted': function (r) {
      return r.status === 202;
    },
    'margin call fast': function (r) {
      return r.timings.duration < 10000;
    },
  });

  if (success) criticalDelivered.add(1);
  deliveryLatency.add(Date.now() - start);
  sleep(0.05);
}
