-- Migration: 20260921000002_encrypt_user_pii
--
-- Prepares "users" for column-level encryption of phone and email
-- (spec Section A10.2). The encryption itself needs the application key, so it
-- cannot run in SQL; existing rows are converted by `npm run pii:encrypt`
-- (scripts/encrypt-existing-pii.ts), which is idempotent.
--
-- 1. phone/email become TEXT: an AES-256-GCM value ("enc:v1:" + base64) is far
--    longer than VARCHAR(20).
-- 2. The UNIQUE constraints and plain indexes on phone/email are dropped: with a
--    random IV per value a ciphertext is always unique, so they would enforce
--    nothing and index nothing useful.
-- 3. "phoneHash"/"emailHash" (HMAC-SHA256 blind indexes, hex) take over: unique,
--    searchable, and reveal nothing without the separate PII_HASH_KEY.
--    They are nullable only so this migration can run before the backfill; the
--    application always writes them, and UNIQUE ignores NULLs.

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_email_key";
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_phone_key";
DROP INDEX IF EXISTS "users_email_key";
DROP INDEX IF EXISTS "users_phone_key";
DROP INDEX IF EXISTS "users_email_idx";
DROP INDEX IF EXISTS "users_phone_idx";

ALTER TABLE "users"
  ALTER COLUMN "email" TYPE TEXT,
  ALTER COLUMN "phone" TYPE TEXT,
  ADD COLUMN IF NOT EXISTS "emailHash" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "phoneHash" VARCHAR(64);

CREATE UNIQUE INDEX "users_emailHash_key" ON "users"("emailHash");
CREATE UNIQUE INDEX "users_phoneHash_key" ON "users"("phoneHash");
