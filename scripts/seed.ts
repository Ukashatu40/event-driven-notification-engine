// scripts/seed.ts
// dotenv must be the very first thing — before any other import
// Use require() to guarantee execution order
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({
  path: require('path').resolve(process.cwd(), '.env'),
});

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter }); // Option mapping is required here

const LANGUAGES = ['EN', 'HI', 'MR', 'TA', 'TE'] as const;
const ACCOUNT_TYPES = ['BASIC', 'PREMIUM', 'HNI'] as const;
const RISK_PROFILES = ['CONSERVATIVE', 'MODERATE', 'AGGRESSIVE'] as const;

function randomFrom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!;
}

function generatePhone(index: number): string {
  return `+919${String(index).padStart(9, '0')}`;
}

function generateEmail(index: number): string {
  return `user${index}@wealthbridge-test.in`;
}

async function seedUsers(count: number): Promise<void> {
  console.log(`Seeding ${count} users...`);

  for (let i = 0; i < count; i++) {
    const isDndRegistered = Math.random() < 0.3;

    const user = await prisma.user.create({
      data: {
        name: `Test User ${i + 1}`,
        email: generateEmail(i + 1),
        phone: generatePhone(i + 1),
        language: randomFrom(LANGUAGES),
        timezone: 'Asia/Kolkata',
        accountType: randomFrom(ACCOUNT_TYPES),
        riskProfile: randomFrom(RISK_PROFILES),
        dndStatus: isDndRegistered ? 'REGISTERED' : 'NOT_REGISTERED',
        quietHoursStart: '21:00',
        quietHoursEnd: '08:00',
      },
    });

    const categories = ['TXNX', 'RISK', 'SIPX', 'MKTX', 'REGX'];
    const channels = ['sms', 'email', 'push', 'whatsapp', 'in_app'];

    for (const category of categories) {
      for (const channel of channels) {
        const isWhatsAppEnabled =
          channel === 'whatsapp' &&
          ['PREMIUM', 'HNI'].includes(user.accountType);

        await prisma.userPreference.create({
          data: {
            userId: user.id,
            eventCategory: category,
            channel,
            enabled: channel !== 'whatsapp' || isWhatsAppEnabled,
            digestMode: category === 'MKTX' ? 'DAILY' : 'IMMEDIATE',
          },
        });
      }
    }

    if ((i + 1) % 100 === 0) {
      console.log(`  ${i + 1}/${count} users seeded...`);
    }
  }

  console.log(`✓ Seeded ${count} users`);
}

async function seedTemplates(): Promise<void> {
  console.log('Seeding templates...');

  const eventTypes = [
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

  for (const eventType of eventTypes) {
    await prisma.template.upsert({
      where: { id: `${eventType}-v1` },
      create: {
        id: `${eventType}-v1`,
        eventType,
        version: 1,
        isActive: true,
        channels: {},
        localisations: {},
      },
      update: {},
    });
  }

  console.log(`✓ Seeded ${eventTypes.length} templates`);
}

async function seedProviderHealth(): Promise<void> {
  console.log('Seeding provider health records...');

  const providers = [
    { provider: 'msg91', channel: 'sms' },
    { provider: 'twilio', channel: 'sms' },
    { provider: 'nodemailer', channel: 'email' },
    { provider: 'fcm', channel: 'push' },
    { provider: 'whatsapp_cloud', channel: 'whatsapp' },
    { provider: 'in_app', channel: 'in_app' },
  ];

  for (const p of providers) {
    await prisma.providerHealth.upsert({
      where: { provider: p.provider },
      create: {
        provider: p.provider,
        channel: p.channel,
        circuitState: 'CLOSED',
        failureCount: 0,
        successCount: 0,
      },
      update: {},
    });
  }

  console.log(`✓ Seeded ${providers.length} provider health records`);
}

async function main(): Promise<void> {
  console.log('Starting database seed...\n');
  console.log(
    `DATABASE_URL: ${process.env.DATABASE_URL ? 'loaded ✓' : 'MISSING ✗'}`,
  );

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Check your .env file.');
  }

  await seedTemplates();
  await seedProviderHealth();
  await seedUsers(1000);

  console.log('\n✓ Seed complete');
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
