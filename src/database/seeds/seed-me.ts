// src/database/seeds/seed-me.ts
//
// Creates (or updates) ONE user with YOUR real email/phone, so /portal/login
// can actually deliver an OTP you can receive — the bulk-seeded users have
// fake test addresses (…@wealthbridge-test.in, +9190000000xx) that were never
// real numbers/inboxes.
//
// Usage:
//   npm run seed:me -- --email=you@example.com [--name="Your Name"] [--phone=+2348031234567] [--market=NG] [--language=EN]
//
// Phone is optional — omit it and only email OTP will work for this user
// (fine, since SMS providers cost money to actually deliver). If you do give
// a phone, use one you can actually receive a text on.
require('dotenv').config({
  path: require('path').resolve(process.cwd(), '.env'),
});

import { Market, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { blindIndex, encryptPii } from '../../shared/utils/pii-masker.util';
import { defaultPreferenceRows } from '../../shared/defaults/default-preferences';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const PII_KEY = Buffer.from(process.env.PII_ENCRYPTION_KEY ?? '', 'hex');
const HASH_KEY = Buffer.from(process.env.PII_HASH_KEY ?? '', 'utf8');
if (PII_KEY.length !== 32 || HASH_KEY.length < 32) {
  throw new Error(
    'Set PII_ENCRYPTION_KEY (64 hex chars) and PII_HASH_KEY (>=32 chars) in .env',
  );
}

function arg(name: string): string | undefined {
  return process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=');
}

async function main(): Promise<void> {
  const email = arg('email');
  if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
    throw new Error(
      'Usage: npm run seed:me -- --email=you@example.com [--name="Your Name"] [--phone=+...] [--market=NG]',
    );
  }
  const name = arg('name') ?? 'Demo User';
  const phone = arg('phone') ?? '+10000000000'; // placeholder — never sent to, unless you pass a real one
  const marketArg = arg('market')?.toUpperCase();
  const market =
    marketArg && marketArg in Market ? (marketArg as Market) : Market.IN;
  const language = arg('language')?.toUpperCase() ?? 'EN';

  const emailHash = blindIndex(`email:${email.trim().toLowerCase()}`, HASH_KEY);
  const phoneHash = blindIndex(
    `phone:${phone.replace(/[\s-]/g, '')}`,
    HASH_KEY,
  );

  const existing = await prisma.user.findUnique({ where: { emailHash } });
  const data = {
    name,
    email: encryptPii(email, PII_KEY),
    emailHash,
    phone: encryptPii(phone, PII_KEY),
    phoneHash,
    market,
    language: language as never, // validated loosely here; the DB enum is the real guard
    isActive: true,
  };

  const user = existing
    ? await prisma.user.update({ where: { id: existing.id }, data })
    : await prisma.user.create({ data });

  // Default notification preferences (same shape as the bulk seed script) —
  // without these the Preferences page has nothing to show. Only on first
  // creation: never overwrite a real, already-customised set of preferences
  // on a re-run. Deliberately NOT doing the same for consent — that seed
  // script's rows are explicitly synthetic test data; fabricating consent for
  // a real account, even the developer's own, is exactly what this project's
  // consent design is built to never do. Consent starts empty and genuine.
  const hasPreferences = await prisma.userPreference.count({
    where: { userId: user.id },
  });
  if (hasPreferences === 0) {
    await prisma.userPreference.createMany({
      data: defaultPreferenceRows(user.id),
    });
  }

  console.log(
    `${existing ? 'Updated' : 'Created'} ${user.id} — ${name} <${email}>`,
  );
  console.log(`\nSign in at /portal/login with:\n  email: ${email}`);
  if (phone !== '+10000000000') console.log(`  phone: ${phone}`);
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
