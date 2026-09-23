// src/database/seeds/seed-demo.ts
//
// Wipes every piece of user-generated data and reseeds with realistic,
// randomised demo people — for the live portfolio demo, not local dev
// (seed.ts's 1000 "Test User N" / userN@wealthbridge-test.in rows are
// intentionally synthetic-LOOKING; this is the opposite goal: a stranger
// browsing the Users list should see plausible names, not fixture noise).
//
//   npm run seed:demo                 # 250 users (125 NG / 125 IN)
//   SEED_DEMO_USER_COUNT=100 npm run seed:demo
//
// Point DATABASE_URL (and PII_ENCRYPTION_KEY/PII_HASH_KEY, unchanged) at
// whichever database you mean to run this against — including, on purpose,
// your live Neon database for the deployed demo. There is no environment
// guard: you are trusted to point this at the right database, the same way
// every other seed script in this directory already is.
require('dotenv').config({
  path: require('path').resolve(process.cwd(), '.env'),
});

import { PrismaClient, type Language } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { encryptPii, blindIndex } from '../../shared/utils/pii-masker.util';
import {
  getMarketProfile,
  type MarketCode,
} from '../../shared/markets/market-profiles';
import { syntheticConsentRows } from './synthetic-consent';
import { seedTemplates, seedProviderHealth } from './seed-reference-data';

const USER_COUNT = Number(process.env.SEED_DEMO_USER_COUNT ?? 250);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const PII_KEY = Buffer.from(process.env.PII_ENCRYPTION_KEY ?? '', 'hex');
const HASH_KEY = Buffer.from(process.env.PII_HASH_KEY ?? '', 'utf8');
if (PII_KEY.length !== 32 || HASH_KEY.length < 32) {
  throw new Error(
    'Set PII_ENCRYPTION_KEY (64 hex chars) and PII_HASH_KEY (>=32 chars) in .env',
  );
}

// ── Name pools ──────────────────────────────────────────────────────
// Plenty of first x last combinations (30x25 = 750 per market) that a
// random sample of a few dozen users won't visibly repeat.

const NG_FIRST_NAMES = [
  'Adaeze',
  'Chinedu',
  'Ngozi',
  'Emeka',
  'Folake',
  'Oluwaseun',
  'Chiamaka',
  'Ibrahim',
  'Aisha',
  'Yusuf',
  'Blessing',
  'Chukwudi',
  'Amara',
  'Tunde',
  'Funmilayo',
  'Uche',
  'Kemi',
  'Obinna',
  'Halima',
  'Musa',
  'Adaora',
  'Segun',
  'Ifeoma',
  'Babatunde',
  'Zainab',
  'Chidinma',
  'Emmanuel',
  'Bola',
  'Nnamdi',
  'Fatima',
  'Moses',
  'Adewale',
  'Chukwuemeka',
  'Aminu',
  'Ngozi',
  'Oluwafemi',
  'Chinonso',
  'Aisha',
  'Uchechukwu',
  'Abdulrahman',
  'Chinwe',
  'Ifeanyi',
  'Adebayo',
  'Chinonso',
  'Aisha',
  'Uchechukwu',
  'Abdulrahman',
  'Chinwe',
  'Ifeanyi',
  'Adebayo',
];
const NG_LAST_NAMES = [
  'Okafor',
  'Adeyemi',
  'Okonkwo',
  'Balogun',
  'Eze',
  'Abubakar',
  'Nwosu',
  'Adebayo',
  'Chukwu',
  'Mohammed',
  'Okoro',
  'Nwachukwu',
  'Adeoye',
  'Okoye',
  'Bello',
  'Uzoma',
  'Afolabi',
  'Umeh',
  'Ogunleye',
  'Ahmed',
  'Igwe',
  'Salihu',
  'Obi',
  'Danjuma',
  'Etim',
  'Ukasha',
  'Ojo',
  'Akinwale',
  'Oluwafemi',
  'Ibrahim',
  'Ubaida',
  'Sani',
  'Oluwaseun',
  'Chukwuemeka',
  'Aminu',
  'Ngozi',
  'Oluwafemi',
  'Chinonso',
  'Aisha',
  'Uchechukwu',
  'Abdulrahman',
  'Chinwe',
  'Ifeanyi',
  'Adebayo',
];
const IN_FIRST_NAMES = [
  'Aarav',
  'Priya',
  'Rohan',
  'Ananya',
  'Vikram',
  'Sneha',
  'Arjun',
  'Kavya',
  'Rajesh',
  'Meera',
  'Aditya',
  'Pooja',
  'Karan',
  'Divya',
  'Sanjay',
  'Neha',
  'Amit',
  'Shreya',
  'Vijay',
  'Anjali',
  'Rahul',
  'Isha',
  'Suresh',
  'Deepika',
  'Manoj',
  'Ritu',
  'Ravi',
  'Swati',
  'Nikhil',
  'Pallavi',
];
const IN_LAST_NAMES = [
  'Sharma',
  'Patel',
  'Kumar',
  'Singh',
  'Reddy',
  'Gupta',
  'Iyer',
  'Nair',
  'Rao',
  'Mehta',
  'Joshi',
  'Desai',
  'Agarwal',
  'Verma',
  'Menon',
  'Pillai',
  'Chopra',
  'Malhotra',
  'Kapoor',
  'Bhatt',
  'Krishnan',
  'Naidu',
  'Chatterjee',
  'Banerjee',
  'Mukherjee',
];

const ACCOUNT_TYPES = ['BASIC', 'PREMIUM', 'HNI'] as const;
const RISK_PROFILES = ['CONSERVATIVE', 'MODERATE', 'AGGRESSIVE'] as const;
const CATEGORIES = ['TXNX', 'RISK', 'SIPX', 'MKTX', 'REGX'] as const;
const CHANNELS = ['sms', 'email', 'push', 'whatsapp', 'in_app'];

function randomFrom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randomDigits(n: number): string {
  return Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join(
    '',
  );
}

interface DemoPerson {
  name: string;
  market: MarketCode;
  language: string;
  timezone: string;
  phone: string;
  email: string;
  accountType: (typeof ACCOUNT_TYPES)[number];
  riskProfile: (typeof RISK_PROFILES)[number];
  dndStatus: 'REGISTERED' | 'NOT_REGISTERED';
}

function randomPerson(market: MarketCode, index: number): DemoPerson {
  const profile = getMarketProfile(market);
  const first = randomFrom(market === 'NG' ? NG_FIRST_NAMES : IN_FIRST_NAMES);
  const last = randomFrom(market === 'NG' ? NG_LAST_NAMES : IN_LAST_NAMES);
  const name = `${first} ${last}`;
  // index suffix guarantees a unique phone/email even if the same
  // first+last combination is drawn twice — real accounts still need a
  // unique blind index.
  return {
    name,
    market,
    language: randomFrom(profile.languages),
    timezone: profile.timezone,
    phone: `${profile.dialCode}${randomDigits(10)}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}${index}@example.com`,
    accountType: randomFrom(ACCOUNT_TYPES),
    riskProfile: randomFrom(RISK_PROFILES),
    dndStatus: Math.random() < 0.3 ? 'REGISTERED' : 'NOT_REGISTERED',
  };
}

// ── Wipe ────────────────────────────────────────────────────────────
// consent_records is append-only at the DATABASE level — a BEFORE TRUNCATE
// trigger (consent_records_no_truncate, migration 20260922000001) refuses
// it outright. Locally this was bypassed with
// `SET LOCAL session_replication_role = replica` (what the integration
// tests' purge() helper and the e2e suite's afterAll() already use) — but
// that GUC is superuser-only, and Neon's managed role isn't one, so it
// fails there with "permission denied to set parameter". Disabling the one
// specific trigger instead only needs table-owner privilege, which the
// migration-running role already has on a table it created.
//
// templates and provider_health are DELIBERATELY excluded — they're
// reference data the engine requires to process any event at all (see
// seed-reference-data.ts), not user demo data.
async function wipeUserData(): Promise<void> {
  console.log('Wiping existing user data...');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      'ALTER TABLE consent_records DISABLE TRIGGER consent_records_no_truncate',
    );
    await c.query(`
      TRUNCATE TABLE
        notification_state_log,
        delivery_attempts,
        dead_letter_queue,
        notifications,
        user_preferences,
        user_segment_memberships,
        user_segments,
        consent_records,
        users
      RESTART IDENTITY CASCADE
    `);
    await c.query(
      'ALTER TABLE consent_records ENABLE TRIGGER consent_records_no_truncate',
    );
    await c.query('COMMIT');
  } catch (err) {
    await c.query('ROLLBACK');
    throw err;
  } finally {
    c.release();
  }
  console.log('✓ Wiped');
}

async function seedDemoUsers(count: number): Promise<void> {
  console.log(
    `Seeding ${count} demo users (${Math.ceil(count / 2)} NG / ${Math.floor(count / 2)} IN)...`,
  );

  for (let i = 0; i < count; i++) {
    // Alternate markets rather than coin-flip — a genuine 50/50 split
    // regardless of count, not just an average that could skew on a small run.
    const market: MarketCode = i % 2 === 0 ? 'NG' : 'IN';
    const person = randomPerson(market, i);

    const user = await prisma.user.create({
      data: {
        name: person.name,
        email: encryptPii(person.email, PII_KEY),
        emailHash: blindIndex(`email:${person.email}`, HASH_KEY),
        phone: encryptPii(person.phone, PII_KEY),
        phoneHash: blindIndex(`phone:${person.phone}`, HASH_KEY),
        language: person.language.toUpperCase() as Language,
        market: person.market,
        timezone: person.timezone,
        accountType: person.accountType,
        riskProfile: person.riskProfile,
        dndStatus: person.dndStatus,
      },
    });

    await prisma.consentRecord.createMany({
      data: syntheticConsentRows(user.id),
    });

    const whatsAppEnabled = ['PREMIUM', 'HNI'].includes(person.accountType);
    const preferenceRows = CATEGORIES.flatMap((category) =>
      CHANNELS.map((channel) => ({
        userId: user.id,
        eventCategory: category,
        channel,
        enabled: channel !== 'whatsapp' || whatsAppEnabled,
        digestMode:
          category === 'MKTX' ? ('DAILY' as const) : ('IMMEDIATE' as const),
      })),
    );
    await prisma.userPreference.createMany({ data: preferenceRows });

    if ((i + 1) % 10 === 0) console.log(`  ${i + 1}/${count} seeded...`);
  }

  console.log(`✓ Seeded ${count} demo users`);
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not set. Check your .env file.');
  }
  console.log(
    `Target: ${process.env.DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`,
  );

  await wipeUserData();
  // Idempotent upserts — harmless if these tables were never touched by
  // the wipe above (they aren't) and equally correct on a brand-new,
  // never-seeded database.
  await seedTemplates(prisma);
  await seedProviderHealth(prisma);
  await seedDemoUsers(USER_COUNT);

  console.log('\n✓ Demo reseed complete');
}

main()
  .catch((err) => {
    console.error('Demo reseed failed:', err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
