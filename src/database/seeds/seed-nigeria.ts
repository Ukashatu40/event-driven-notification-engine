// src/database/seeds/seed-nigeria.ts
// Seeds Nigerian-market users (market NG, Africa/Lagos, +234 numbers) across
// English, Pidgin, Hausa, Yoruba and Igbo. Phone/email are encrypted like every
// other user row. Re-runnable: existing rows (matched by blind index) are skipped.
//
//   npm run seed:ng [-- 25]
//
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({
  path: require('path').resolve(process.cwd(), '.env'),
});

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { syntheticConsentRows } from './synthetic-consent';
import { blindIndex, encryptPii } from '../../shared/utils/pii-masker.util';

const KEY = Buffer.from(process.env.PII_ENCRYPTION_KEY ?? '', 'hex');
const HASH_KEY = Buffer.from(process.env.PII_HASH_KEY ?? '', 'utf8');
if (KEY.length !== 32 || HASH_KEY.length < 32) {
  throw new Error('Set PII_ENCRYPTION_KEY and PII_HASH_KEY in .env');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg(
    new Pool({ connectionString: process.env.DATABASE_URL }),
  ),
});

const LANGUAGES = ['EN', 'PCM', 'HA', 'YO', 'IG'] as const;
const NAMES = [
  'Adaeze Okafor',
  'Musa Ibrahim',
  'Tunde Adeyemi',
  'Ngozi Eze',
  'Amina Bello',
];

async function main(): Promise<void> {
  const count = Number(process.argv[2] ?? 25);
  let created = 0;

  for (let i = 0; i < count; i++) {
    const phone = `+234803${String(1000000 + i).padStart(7, '0')}`;
    const email = `ng.user${i + 1}@wealthbridge-test.ng`;
    const phoneHash = blindIndex(`phone:${phone}`, HASH_KEY);

    if (
      await prisma.user.findUnique({
        where: { phoneHash },
        select: { id: true },
      })
    )
      continue;

    const user = await prisma.user.create({
      data: {
        name: NAMES[i % NAMES.length],
        phone: encryptPii(phone, KEY),
        phoneHash,
        email: encryptPii(email, KEY),
        emailHash: blindIndex(`email:${email}`, HASH_KEY),
        language: LANGUAGES[i % LANGUAGES.length],
        market: 'NG',
        timezone: 'Africa/Lagos',
        accountType: (['BASIC', 'PREMIUM', 'HNI'] as const)[i % 3],
        dndStatus: i % 4 === 0 ? 'REGISTERED' : 'NOT_REGISTERED',
      },
    });
    await prisma.consentRecord.createMany({
      data: syntheticConsentRows(user.id),
    });

    for (const category of ['TXNX', 'RISK', 'SIPX', 'MKTX', 'REGX']) {
      for (const channel of ['sms', 'email', 'push', 'whatsapp', 'in_app']) {
        await prisma.userPreference.create({
          data: {
            userId: user.id,
            eventCategory: category,
            channel,
            enabled: true,
            digestMode: 'IMMEDIATE',
          },
        });
      }
    }
    created++;
  }
  console.log(
    `✓ created ${created} Nigerian users (${count - created} already existed)`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
