// tests/load/multi-language.k6.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

const throughputRate = new Rate('target_throughput_met');

export const options = {
  scenarios: {
    multilang_broadcast: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 50,
      maxVUs: 100,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<2000'],
    target_throughput_met: ['rate>0.90'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  const userId = 'user-' + (Math.floor(Math.random() * 1000) + 1);
  const start = Date.now();

  const today = new Date().toISOString().split('T')[0];

  const payload = JSON.stringify({
    eventType: 'REGX-005',
    eventId: 'EVT-RBI-' + Date.now() + '-' + Math.floor(Math.random() * 99999),
    sourceSystem: 'compliance_system',
    timestamp: new Date().toISOString(),
    priority: 3,
    userId: userId,
    payload: {
      change_summary: 'RBI Emergency Rate Hike: Repo rate increased by 50bps',
      impact:
        'EMI on floating rate loans will increase from next billing cycle',
      effective_date: today,
    },
  });

  const res = http.post(BASE_URL + '/api/v1/events', payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '10s',
  });

  const success = check(res, {
    'broadcast accepted': function (r) {
      return r.status === 202;
    },
    'within latency budget': function (r) {
      return r.timings.duration < 2000;
    },
  });

  throughputRate.add(success && Date.now() - start < 2000 ? 1 : 0);
  sleep(0);
}
