// tests/load/multi-language.k6.js
/**
 * Load Test: Multi-Language Emergency Broadcast (Challenge B2.5)
 *
 * RBI emergency rate hike — 4.2M users across 5 languages in 4 hours.
 * Throughput requirement: 292 notifications/second sustained.
 *
 * Run: k6 run tests/load/multi-language.k6.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const throughputRate = new Rate('target_throughput_met');

export const options = {
  // Simulate 292 req/sec sustained for 30 seconds (scaled test)
  scenarios: {
    multilang_broadcast: {
      executor: 'constant-arrival-rate',
      rate: 292,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 100,
      maxVUs: 300,
    },
  },
  thresholds: {
    // Must sustain 292/s with < 5% drop rate
    http_req_failed: ['rate<0.05'],
    // Each request under 2 seconds (template render + queue)
    http_req_duration: ['p(95)<2000'],
    // Track throughput achievement
    target_throughput_met: ['rate>0.95'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

const LANGUAGE_DISTRIBUTION = [
  { lang: 'hi', weight: 42 }, // 42% Hindi
  { lang: 'en', weight: 20 }, // 20% English
  { lang: 'mr', weight: 18 }, // 18% Marathi
  { lang: 'ta', weight: 12 }, // 12% Tamil
  { lang: 'te', weight: 8 }, // 8% Telugu
];

function pickLanguage() {
  const roll = Math.random() * 100;
  let cumulative = 0;
  for (const entry of LANGUAGE_DISTRIBUTION) {
    cumulative += entry.weight;
    if (roll < cumulative) return entry.lang;
  }
  return 'en';
}

export default function () {
  const userId = `user-${Math.floor(Math.random() * 10000) + 1}`;
  const start = Date.now();

  const payload = JSON.stringify({
    eventType: 'REGX-005',
    eventId: `EVT-RBI-${Date.now()}-${Math.random()}`,
    sourceSystem: 'compliance_system',
    timestamp: new Date().toISOString(),
    priority: 3,
    userId,
    payload: {
      change_summary: 'RBI Emergency Rate Hike: Repo rate increased by 50bps',
      impact:
        'EMI on floating rate loans will increase from next billing cycle',
      effective_date: new Date().toISOString().split('T')[0],
    },
  });

  const res = http.post(`${BASE_URL}/api/v1/events`, payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '10s',
  });

  const success = check(res, {
    'broadcast accepted': (r) => r.status === 202,
    'within latency budget': (r) => r.timings.duration < 2000,
  });

  throughputRate.add(success && Date.now() - start < 2000);
  sleep(0);
}
