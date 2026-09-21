// scripts/encrypt-existing-pii.ts
//
// One-off, idempotent backfill for migration 20260921000002_encrypt_user_pii:
// encrypts users.phone / users.email that are still plaintext and fills the
// blind-index columns. Safe to re-run — values already in "enc:v1:" form are
// left alone, and hashes are (re)computed from the decrypted value.
//
//   npm run pii:encrypt
//
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config({
  path: require('path').resolve(process.cwd(), '.env'),
});

import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import {
  blindIndex,
  decryptPii,
  encryptPii,
  isEncryptedPii,
} from '../src/shared/utils/pii-masker.util';

const KEY = Buffer.from(process.env.PII_ENCRYPTION_KEY ?? '', 'hex');
const HASH_KEY = Buffer.from(process.env.PII_HASH_KEY ?? '', 'utf8');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

const plain = (value: string): string =>
  isEncryptedPii(value) ? decryptPii(value, KEY) : value;

async function main(): Promise<void> {
  if (KEY.length !== 32 || HASH_KEY.length < 32) {
    throw new Error(
      'Set PII_ENCRYPTION_KEY (64 hex chars) and PII_HASH_KEY (>=32 chars)',
    );
  }

  const BATCH = 500;
  let cursor: string | undefined;
  let encrypted = 0;
  let scanned = 0;

  for (;;) {
    const users = await prisma.user.findMany({
      take: BATCH,
      ...(cursor && { skip: 1, cursor: { id: cursor } }),
      orderBy: { id: 'asc' },
      select: {
        id: true,
        phone: true,
        email: true,
        phoneHash: true,
        emailHash: true,
      },
    });
    if (users.length === 0) break;

    for (const u of users) {
      scanned++;
      const phone = plain(u.phone);
      const email = plain(u.email);
      const phoneHash = blindIndex(
        `phone:${phone.replace(/[\s-]/g, '')}`,
        HASH_KEY,
      );
      const emailHash = blindIndex(
        `email:${email.trim().toLowerCase()}`,
        HASH_KEY,
      );

      const needsWork =
        !isEncryptedPii(u.phone) ||
        !isEncryptedPii(u.email) ||
        u.phoneHash !== phoneHash ||
        u.emailHash !== emailHash;
      if (!needsWork) continue;

      await prisma.user.update({
        where: { id: u.id },
        data: {
          phone: isEncryptedPii(u.phone) ? u.phone : encryptPii(phone, KEY),
          email: isEncryptedPii(u.email) ? u.email : encryptPii(email, KEY),
          phoneHash,
          emailHash,
        },
      });
      encrypted++;
    }
    cursor = users[users.length - 1]!.id;
  }

  console.log(`✓ scanned ${scanned} users, encrypted/backfilled ${encrypted}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
    await pool.end();
  });
