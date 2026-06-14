// tests/load/multi-language.k6.js
import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    multilang_broadcast: {
      executor: 'constant-arrival-rate',
      rate: 30,
      timeUnit: '1s',
      duration: '30s',
      preAllocatedVUs: 30,
      maxVUs: 60,
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.05'],
    http_req_duration: ['p(95)<2000'],
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
  var today = new Date().toISOString().split('T')[0];

  var payload = JSON.stringify({
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

  var res = http.post(BASE_URL + '/api/v1/events', payload, {
    headers: { 'Content-Type': 'application/json' },
    timeout: '10s',
  });

  check(res, {
    'broadcast accepted': function (r) {
      return r.status === 202;
    },
    'within latency budget': function (r) {
      return r.timings.duration < 2000;
    },
  });
}
