-- Migration: 20260922000001_consent_and_digest
--
-- 1. New notification states
--      NO_CONSENT     — blocked at dispatch: no valid consent on record
--      DIGEST_PENDING — held for a digest
--      DIGESTED       — delivered as part of a digest notification
-- 2. notifications."consentRecordId" — the consent record that authorised a send,
--    so the TRAI/NCC audit (spec B2.3) can prove consent per message rather than
--    infer it from timestamps.
-- 3. consent_records becomes append-only. Consent is legal evidence (spec C3.3:
--    "immutable consent audit logs with timestamps, IP addresses, and consent
--    text"); withdrawing consent is a NEW record (granted = false), never an
--    edit or a delete. Enforced in the database, so no code path — including a
--    future bug or an ad-hoc SQL session — can rewrite history.

ALTER TYPE "NotificationStatus" ADD VALUE IF NOT EXISTS 'NO_CONSENT';
ALTER TYPE "NotificationStatus" ADD VALUE IF NOT EXISTS 'DIGEST_PENDING';
ALTER TYPE "NotificationStatus" ADD VALUE IF NOT EXISTS 'DIGESTED';

ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "consentRecordId" UUID;

CREATE OR REPLACE FUNCTION consent_records_append_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'consent_records is append-only: % is not permitted (record a new consent event instead)', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

DROP TRIGGER IF EXISTS consent_records_no_update_delete ON "consent_records";
CREATE TRIGGER consent_records_no_update_delete
  BEFORE UPDATE OR DELETE ON "consent_records"
  FOR EACH ROW EXECUTE FUNCTION consent_records_append_only();

DROP TRIGGER IF EXISTS consent_records_no_truncate ON "consent_records";
CREATE TRIGGER consent_records_no_truncate
  BEFORE TRUNCATE ON "consent_records"
  FOR EACH STATEMENT EXECUTE FUNCTION consent_records_append_only();

-- Newest-first lookups per (user, channel) are the hot path of consent enforcement.
CREATE INDEX IF NOT EXISTS "consent_records_userId_channel_grantedAt_idx"
  ON "consent_records"("userId", "channel", "grantedAt" DESC);
