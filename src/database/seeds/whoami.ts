// src/database/seeds/whoami.ts
//
// Local-dev convenience: prints a few seeded users' DECRYPTED phone/email so
// you have something real to type into /portal/login without hand-decrypting
// a row yourself. Reads straight from the database with the app's own PII
// key — never expose this, or anything like it, outside your own machine.
//
// Usage: npm run whoami [-- --market=NG] [-- --limit=5]
require('dotenv').config({
  path: require('path').resolve(process.cwd(), '.env'),
});

import { Market, PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { decryptPii } from '../../shared/utils/pii-masker.util';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

const PII_KEY = Buffer.from(process.env.PII_ENCRYPTION_KEY ?? '', 'hex');
if (PII_KEY.length !== 32) {
  throw new Error('Set PII_ENCRYPTION_KEY (64 hex chars) in .env');
}

function arg(name: string, fallback: string): string {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  return flag ? flag.split('=')[1] : fallback;
}

async function main(): Promise<void> {
  const market = arg('market', '');
  const limit = Number(arg('limit', '5'));

  const marketFilter =
    market && market in Market ? { market: market as Market } : {};
  const users = await prisma.user.findMany({
    where: { isActive: true, ...marketFilter },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true,
      name: true,
      market: true,
      language: true,
      phone: true,
      email: true,
    },
  });

  if (users.length === 0) {
    console.log(
      'No active users found. Run `npm run seed` (and `npm run seed:ng` for Nigerian users) first.',
    );
    return;
  }

  console.log(
    'Sign in at /portal/login with any of these (dev database only):\n',
  );
  for (const u of users) {
    console.log(`${u.name}  ·  ${u.market}/${u.language}  ·  ${u.id}`);
    console.log(`  phone: ${decryptPii(u.phone, PII_KEY)}`);
    console.log(`  email: ${decryptPii(u.email, PII_KEY)}\n`);
  }
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
