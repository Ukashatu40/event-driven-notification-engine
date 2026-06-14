// scripts/export-user-ids.ts
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({
  path: require('path').resolve(process.cwd(), '.env'),
});

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { writeFileSync } from 'fs';

// 🔑 1. Create the native PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// 🔑 2. Wrap it with the Prisma 7 driver adapter
const adapter = new PrismaPg(pool);

// 🔑 3. Instantiate PrismaClient using exclusively the adapter option
const prisma = new PrismaClient({ adapter });

async function main(): Promise<void> {
  const users = await prisma.user.findMany({
    select: { id: true },
    take: 100,
  });

  const ids = users.map((u) => u.id).join(',');

  // Write to a file k6 can read via --env
  writeFileSync('scripts/user-ids.txt', ids);
  console.log(`Exported ${users.length} user IDs to scripts/user-ids.txt`);
  console.log('\nRun load test with:');
  console.log(
    `k6 run -e USER_IDS="$(cat scripts/user-ids.txt)" tests/load/market-crash.k6.js`,
  );
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
