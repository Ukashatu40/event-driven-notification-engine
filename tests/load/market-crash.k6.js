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
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Histogram } from 'k6/metrics';

const criticalDelivered = new Counter('critical_delivered');
const deliveryLatency = new Histogram('delivery_latency_ms');

export const options = {
  scenarios: {
    // Scenario 1: Price alerts (450K users)
    price_alerts: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 500 },
        { duration: '2m', target: 500 },
        { duration: '30s', target: 0 },
      ],
      tags: { scenario: 'price_alerts' },
    },
    // Scenario 2: Margin calls (28K users, CRITICAL)
    margin_calls: {
      executor: 'constant-vus',
      vus: 100,
      duration: '3m',
      tags: { scenario: 'margin_calls' },
      startTime: '10s',
    },
  },
  thresholds: {
    // Price alerts: 95th percentile under 15 seconds
    'http_req_duration{scenario:price_alerts}': ['p(95)<15000'],
    // Margin calls: 99th percentile under 10 seconds (SEBI requirement)
    'http_req_duration{scenario:margin_calls}': ['p(99)<10000'],
    // Overall error rate under 1%
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

const USERS = Array.from({ length: 1000 }, (_, i) => ({
  userId: `user-${String(i + 1).padStart(4, '0')}`,
  symbol: ['RELIANCE', 'INFY', 'TCS', 'HDFC', 'ICICI'][i % 5],
}));

export default function () {
  const scenario = __ENV.K6_SCENARIO_NAME || 'price_alerts';
  const user = USERS[Math.floor(Math.random() * USERS.length)];

  if (scenario === 'margin_calls') {
    sendMarginCall(user);
  } else {
    sendPriceAlert(user);
  }
}

function sendPriceAlert(user) {
  const start = Date.now();

  const payload = JSON.stringify({
    eventType: 'MKTX-001',
    eventId: `EVT-CRASH-${Date.now()}-${Math.random()}`,
    sourceSystem: 'market_data_feed',
    timestamp: new Date().toISOString(),
    priority: 2,
    userId: user.userId,
    payload: {
      symbol: user.symbol,
      stock_name: user.symbol,
      target_price: 2000,
      current_price: 1840,
      direction: 'BELOW',
    },
  });

  const res = http.post(`${BASE_URL}/api/v1/events`, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '30s',
  });

  const success = check(res, {
    'price alert accepted': (r) => r.status === 202,
    'has notification id': (r) => {
      try {
        return JSON.parse(r.body).notificationId !== undefined;
      } catch {
        return false;
      }
    },
  });

  deliveryLatency.add(Date.now() - start);
  sleep(0.1);
}

function sendMarginCall(user) {
  const start = Date.now();

  const payload = JSON.stringify({
    eventType: 'RISK-001',
    eventId: `EVT-MARGIN-${Date.now()}-${Math.random()}`,
    sourceSystem: 'margin_engine',
    timestamp: new Date().toISOString(),
    priority: 1,
    userId: user.userId,
    payload: {
      shortfall_amount: 125000,
      current_margin: 375000,
      required_margin: 500000,
      deadline: new Date(Date.now() + 3600000).toISOString(),
      auto_square_off_time: new Date(Date.now() + 7200000).toISOString(),
    },
  });

  const res = http.post(`${BASE_URL}/api/v1/events`, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '15s',
  });

  const success = check(res, {
    'margin call accepted': (r) => r.status === 202,
    'margin call fast': (r) => r.timings.duration < 10000,
  });

  if (success) criticalDelivered.add(1);
  deliveryLatency.add(Date.now() - start);
  sleep(0.05);
}
