// src/database/seeds/seed-dnd-cache.ts
require('dotenv').config({
  path: require('path').resolve(process.cwd(), '.env'),
});

import { createClient } from 'redis';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter }); // Option mapping is required here

async function main(): Promise<void> {
  console.log('Seeding DND cache from database...');

  const dndUsers = await prisma.user.findMany({
    where: { dndStatus: 'REGISTERED' },
    select: { id: true },
  });

  const redis = createClient({
    socket: {
      host: process.env.REDIS_HOST ?? 'localhost',
      port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
    },
    password: process.env.REDIS_PASSWORD,
  });

  await redis.connect();

  let count = 0;
  for (const user of dndUsers) {
    await redis.setEx(`dnd:${user.id}`, 86400, 'registered');
    count++;
  }

  // Seed not-registered users too (so cache hits work both ways)
  const nonDndUsers = await prisma.user.findMany({
    where: { dndStatus: 'NOT_REGISTERED' },
    select: { id: true },
    take: 5000,
  });

  for (const user of nonDndUsers) {
    await redis.setEx(`dnd:${user.id}`, 86400, 'not_registered');
    count++;
  }

  await redis.disconnect();
  console.log(`✓ DND cache seeded for ${count} users`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
