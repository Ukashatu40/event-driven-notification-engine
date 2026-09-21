// src/database/seeds/seed-consent.ts
// Adds SYNTHETIC consent for dev/test users that have none — see synthetic-consent.ts.
//   npm run seed:consent
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({
  path: require('path').resolve(process.cwd(), '.env'),
});

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { syntheticConsentRows } from './synthetic-consent';

const prisma = new PrismaClient({
  adapter: new PrismaPg(
    new Pool({ connectionString: process.env.DATABASE_URL }),
  ),
});

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to fabricate consent in production.');
  }

  const users = await prisma.user.findMany({
    where: { consentRecords: { none: {} } },
    select: { id: true },
  });

  for (let i = 0; i < users.length; i += 500) {
    await prisma.consentRecord.createMany({
      data: users.slice(i, i + 500).flatMap((u) => syntheticConsentRows(u.id)),
    });
  }
  console.log(`✓ synthetic consent added for ${users.length} test users`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
