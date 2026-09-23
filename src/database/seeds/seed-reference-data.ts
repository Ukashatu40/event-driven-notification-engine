// src/database/seeds/seed-reference-data.ts
//
// Baseline reference data the ENGINE ITSELF requires to process any event —
// not fake dev/demo content, unlike seed.ts's 1000 synthetic users. Two
// tables, both looked up unconditionally on every dispatch:
//
//   - `template`: AbTestingService.resolveVariant() queries this for every
//     non-digest notification (notification-engine.service.ts) — a
//     TemplateEngineService definition existing in code is NOT enough; the
//     event type also needs an isActive `template` row, or resolveVariant()
//     throws "No active template found" and the event is parked on the DLQ.
//   - `providerHealth`: the circuit-breaker state each delivery adapter reads
//     before sending.
//
// Idempotent (upsert), so it's safe to run against an already-seeded
// database — including a long-lived dev DB `seed.ts` has already populated.
// Used by: `npm run seed:reference` directly (CI's fresh, otherwise-empty
// test database has no other seed step), and by `seed.ts`, which calls these
// same functions rather than keeping its own copy.
require('dotenv').config({
  path: require('path').resolve(process.cwd(), '.env'),
});

import type { PrismaClient } from '@prisma/client';

export const TEMPLATE_EVENT_TYPES = [
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
] as const;

export async function seedTemplates(
  prisma: Pick<PrismaClient, 'template'>,
): Promise<void> {
  console.log('Seeding templates...');

  for (const eventType of TEMPLATE_EVENT_TYPES) {
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

  console.log(`✓ Seeded ${TEMPLATE_EVENT_TYPES.length} templates`);
}

export async function seedProviderHealth(
  prisma: Pick<PrismaClient, 'providerHealth'>,
): Promise<void> {
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
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Check your .env file.');
  }

  // Standalone-run only: seed.ts passes its own already-constructed client
  // instead of hitting this branch, so it never opens a second pool.
  const { PrismaClient } = await import('@prisma/client');
  const { PrismaPg } = await import('@prisma/adapter-pg');
  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    await seedTemplates(prisma);
    await seedProviderHealth(prisma);
    console.log('\n✓ Reference data seed complete');
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Reference data seed failed:', err);
    process.exit(1);
  });
}
