-- Migration: 20260921000004_dlq_failure_class
-- Adds an automated classification to dead-lettered notifications
-- (TRANSIENT | PERMANENT | CONFIGURATION) so operators can filter the DLQ and
-- decide whether a retry can help (spec Day 9).

ALTER TABLE "dead_letter_queue"
  ADD COLUMN "failureClass" VARCHAR(15) NOT NULL DEFAULT 'TRANSIENT';

-- Best-effort backfill of existing rows from their recorded error text.
UPDATE "dead_letter_queue" SET "failureClass" = 'CONFIGURATION'
  WHERE "lastError" ~* 'RENDER_OR_QUEUE_FAILED|REQUEUE_NO_CONTENT|INVALID_TEMPLATE|NOT_CONFIGURED';
UPDATE "dead_letter_queue" SET "failureClass" = 'PERMANENT'
  WHERE "failureClass" = 'TRANSIENT'
    AND "lastError" ~* 'INVALID_RECIPIENT|EXPIRED_TOKEN|BOUNCE|DND_REGISTERED|DND_BLOCKED';

CREATE INDEX "dead_letter_queue_resolved_failureClass_idx"
  ON "dead_letter_queue"("resolved", "failureClass");
