// scripts/generate-datasets.ts
import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Generates the 4 simulation datasets required by spec Section B4.
 * Run: npm run datasets:generate
 */

const OUTPUT_DIR = join(process.cwd(), 'data');

const EVENT_TYPES = [
  'TXNX-001',
  'TXNX-002',
  'TXNX-003',
  'TXNX-004',
  'TXNX-005',
  'RISK-001',
  'RISK-002',
  'RISK-003',
  'RISK-004',
  'RISK-005',
  'SIPX-001',
  'SIPX-002',
  'SIPX-003',
  'SIPX-004',
  'SIPX-005',
  'MKTX-001',
  'MKTX-002',
  'MKTX-003',
  'MKTX-004',
  'MKTX-005',
  'REGX-001',
  'REGX-002',
  'REGX-003',
  'REGX-004',
  'REGX-005',
];

const CHANNELS = ['sms', 'email', 'push', 'whatsapp', 'in_app'];
const LANGUAGES = [
  'en',
  'hi',
  'hi',
  'hi',
  'hi',
  'hi',
  'mr',
  'mr',
  'mr',
  'ta',
  'ta',
  'te',
];
const STATUSES = [
  'DELIVERED',
  'DELIVERED',
  'DELIVERED',
  'DELIVERED',
  'FAILED',
  'CAPPED',
  'DND',
];
const FAILURE_REASONS = [
  'invalid_recipient',
  'provider_timeout',
  'rate_limited',
  'network_error',
  'invalid_template',
  'dnd_blocked',
  'expired_token',
];
const COMPLAINT_TYPES = [
  'too_many_notifications',
  'too_many_notifications',
  'too_many_notifications',
  'wrong_time',
  'wrong_time',
  'irrelevant_content',
  'irrelevant_content',
  'wrong_channel',
  'missing_critical_notification',
];

function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function randomDate(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - Math.floor(Math.random() * daysAgo));
  // Market hours bias: 80% during 09:15-15:30 IST
  if (Math.random() < 0.8) {
    const marketHour = 9 + Math.floor(Math.random() * 6);
    const minute = Math.floor(Math.random() * 60);
    date.setHours(marketHour, minute);
  }
  return date.toISOString();
}

function generateEventDistribution(): string {
  const roll = Math.random();
  if (roll < 0.4) return randomFrom(EVENT_TYPES.slice(0, 5)); // 40% TXNX
  if (roll < 0.6) return randomFrom(EVENT_TYPES.slice(5, 10)); // 20% RISK
  if (roll < 0.75) return randomFrom(EVENT_TYPES.slice(10, 15)); // 15% SIPX
  if (roll < 0.9) return randomFrom(EVENT_TYPES.slice(15, 20)); // 15% MKTX
  return randomFrom(EVENT_TYPES.slice(20, 25)); // 10% REGX
}

// ── Dataset 1: notification_events.csv ───────────────────────────

function generateNotificationEvents(count: number): string {
  const headers =
    'event_id,event_type,user_id,timestamp,priority,source_system,channel_preference,status';
  const rows: string[] = [headers];

  for (let i = 0; i < count; i++) {
    const eventType = generateEventDistribution();
    const priority =
      eventType.startsWith('RISK-00') &&
      ['RISK-001', 'RISK-002', 'RISK-003'].includes(eventType)
        ? 1
        : eventType.startsWith('TXNX')
          ? 2
          : 3;

    rows.push(
      [
        `EVT-${Date.now()}-${i}`,
        eventType,
        `user-${Math.floor(Math.random() * 10000) + 1}`,
        randomDate(30),
        priority,
        'trading_engine',
        randomFrom(CHANNELS),
        randomFrom(STATUSES),
      ].join(','),
    );
  }

  return rows.join('\n');
}

// ── Dataset 2: user_profiles.csv ─────────────────────────────────

function generateUserProfiles(count: number): string {
  const headers =
    'user_id,name,phone,email,language,timezone,dnd_status,account_type,risk_profile,quiet_hours_start,quiet_hours_end';
  const rows: string[] = [headers];

  for (let i = 0; i < count; i++) {
    const isDnd = Math.random() < 0.3;
    const lang = randomFrom(LANGUAGES);

    rows.push(
      [
        `user-${i + 1}`,
        `User ${i + 1}`,
        `+919${String(i).padStart(9, '0')}`,
        `user${i + 1}@test.in`,
        lang,
        'Asia/Kolkata',
        isDnd ? 'registered' : 'not_registered',
        randomFrom(['basic', 'basic', 'premium', 'HNI']),
        randomFrom(['conservative', 'moderate', 'aggressive']),
        '21:00',
        '08:00',
      ].join(','),
    );
  }

  return rows.join('\n');
}

// ── Dataset 3: delivery_failures.csv ─────────────────────────────

function generateDeliveryFailures(count: number): string {
  const headers =
    'notification_id,channel,provider,failure_code,failure_reason,retry_count,final_status,timestamp';
  const rows: string[] = [headers];

  //   const _PROVIDERS = ['msg91', 'twilio', 'nodemailer', 'fcm', 'whatsapp_cloud'];

  for (let i = 0; i < count; i++) {
    const channel = randomFrom(CHANNELS);
    const provider =
      channel === 'sms'
        ? randomFrom(['msg91', 'twilio'])
        : channel === 'email'
          ? 'nodemailer'
          : channel === 'push'
            ? 'fcm'
            : channel === 'whatsapp'
              ? 'whatsapp_cloud'
              : 'in_app';

    const failureReason = randomFrom(FAILURE_REASONS);

    rows.push(
      [
        `notif-${i + 1}`,
        channel,
        provider,
        failureReason.toUpperCase().replace(/_/g, '_'),
        failureReason,
        Math.floor(Math.random() * 5) + 1,
        Math.random() < 0.3 ? 'DLQ' : 'FAILED',
        randomDate(90),
      ].join(','),
    );
  }

  return rows.join('\n');
}

// ── Dataset 4: user_complaints.csv ───────────────────────────────

function generateUserComplaints(count: number): string {
  const headers =
    'complaint_id,user_id,complaint_type,channel,event_type,description,timestamp,resolved';
  const rows: string[] = [headers];

  for (let i = 0; i < count; i++) {
    const complaintType = randomFrom(COMPLAINT_TYPES);
    rows.push(
      [
        `complaint-${i + 1}`,
        `user-${Math.floor(Math.random() * 10000) + 1}`,
        complaintType,
        randomFrom(CHANNELS),
        generateEventDistribution(),
        `User complaint: ${complaintType.replace(/_/g, ' ')}`,
        randomDate(30),
        Math.random() < 0.6 ? 'true' : 'false',
      ].join(','),
    );
  }

  return rows.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────

function main(): void {
  mkdirSync(OUTPUT_DIR, { recursive: true });

  console.log('Generating simulation datasets...\n');

  writeFileSync(
    join(OUTPUT_DIR, 'notification_events.csv'),
    generateNotificationEvents(100_000),
  );
  console.log('✓ notification_events.csv (100,000 rows)');

  writeFileSync(
    join(OUTPUT_DIR, 'user_profiles.csv'),
    generateUserProfiles(10_000),
  );
  console.log('✓ user_profiles.csv (10,000 rows)');

  writeFileSync(
    join(OUTPUT_DIR, 'delivery_failures.csv'),
    generateDeliveryFailures(5_000),
  );
  console.log('✓ delivery_failures.csv (5,000 rows)');

  writeFileSync(
    join(OUTPUT_DIR, 'user_complaints.csv'),
    generateUserComplaints(2_000),
  );
  console.log('✓ user_complaints.csv (2,000 rows)');

  console.log(`\nDatasets written to ${OUTPUT_DIR}/`);
}

main();
