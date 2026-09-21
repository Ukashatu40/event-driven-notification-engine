-- Migration: 20260921000001_partition_notifications
--
-- Converts "notifications" into a table PARTITIONED BY RANGE ("createdAt") with
-- monthly partitions (spec Section A8.1 / Day 2), preserving existing rows.
--
-- Deliberate departures from the spec DDL (documented in docs/database-schema.md):
--
--  1. PRIMARY KEY is ("id", "createdAt"), not ("id").
--     PostgreSQL rejects a unique/primary key on a partitioned table that does
--     not include every partition column ("unique constraint on partitioned
--     table must include all partitioning columns"), so the spec's
--     `id UUID PRIMARY KEY ... PARTITION BY RANGE (created_at)` cannot be created.
--     ids are UUIDv4, so cross-partition collisions are not a practical concern;
--     lookups by id use the PK index on each partition.
--
--  2. The foreign keys from notification_state_log, delivery_attempts and
--     dead_letter_queue to notifications(id) are dropped. A foreign key must
--     reference a unique constraint on exactly the referenced columns, which a
--     partitioned table cannot offer for "id" alone. Those tables are written
--     only by the application in the same code path that creates the
--     notification, and are indexed on "notificationId".
--
-- The Prisma model is intentionally unchanged (id remains @id): Prisma does not
-- introspect partitioning and only issues WHERE "id" = $1 style queries, which
-- work unchanged. Do NOT run `prisma migrate dev` against this schema to
-- "fix drift" — it would try to recreate the dropped constraints. Use
-- `prisma migrate deploy`.

-- ─── 1. Helper: create one monthly UTC partition of a partitioned table ─────────

CREATE OR REPLACE FUNCTION create_notification_partition(parent regclass, month_start date)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  part_name text := format('notifications_y%sm%s',
                           to_char(month_start, 'YYYY'), to_char(month_start, 'MM'));
  lower_bound text := to_char(month_start, 'YYYY-MM-DD') || ' 00:00:00+00';
  upper_bound text := to_char((month_start + interval '1 month')::date, 'YYYY-MM-DD') || ' 00:00:00+00';
BEGIN
  IF to_regclass(part_name) IS NULL THEN
    EXECUTE format(
      'CREATE TABLE %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
      part_name, parent, lower_bound, upper_bound
    );
  END IF;
END;
$$;

-- ─── 2. New partitioned table with the same columns and defaults ────────────────

CREATE TABLE "notifications_p" (LIKE "notifications" INCLUDING DEFAULTS)
  PARTITION BY RANGE ("createdAt");

-- Safety net so an insert can never fail because a month's partition is missing.
-- The maintenance job creates partitions ahead of time; if rows do land here,
-- create the missing partition before it is needed.
CREATE TABLE "notifications_default" PARTITION OF "notifications_p" DEFAULT;

-- Partitions from the oldest existing row through three months ahead.
DO $$
DECLARE
  first_month date := date_trunc('month', COALESCE(
                        (SELECT min("createdAt") FROM "notifications"), now()
                      ) AT TIME ZONE 'UTC')::date;
  last_month  date := (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '3 month')::date;
  m date := first_month;
BEGIN
  WHILE m <= last_month LOOP
    PERFORM create_notification_partition('notifications_p'::regclass, m);
    m := (m + interval '1 month')::date;
  END LOOP;
END;
$$;

-- ─── 3. Move the data, drop the old table ────────────────────────────────────────

INSERT INTO "notifications_p" SELECT * FROM "notifications";

ALTER TABLE "notification_state_log" DROP CONSTRAINT "notification_state_log_notificationId_fkey";
ALTER TABLE "delivery_attempts"      DROP CONSTRAINT "delivery_attempts_notificationId_fkey";
ALTER TABLE "dead_letter_queue"      DROP CONSTRAINT "dead_letter_queue_notificationId_fkey";

DROP TABLE "notifications";
ALTER TABLE "notifications_p" RENAME TO "notifications";

-- ─── 4. Constraints and indexes (created on the parent; Postgres builds one per partition) ──

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_pkey" PRIMARY KEY ("id", "createdAt");

ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Spec A8.2: composite (user_id, status, channel) for user notification queries
CREATE INDEX "notifications_userId_status_channel_idx"
  ON "notifications"("userId", "status", "channel");

-- Spec A8.2: (event_type, created_at) for analytics aggregations
CREATE INDEX "notifications_eventType_createdAt_idx"
  ON "notifications"("eventType", "createdAt");

-- Spec A8.2: BRIN on created_at for time-range scans
CREATE INDEX "notifications_createdAt_brin_idx"
  ON "notifications" USING BRIN ("createdAt");

-- Spec A8.2: GIN on personalisation_data for JSONB queries
CREATE INDEX "notifications_personalisationData_gin_idx"
  ON "notifications" USING GIN ("personalisationData");

-- Spec A8.2: partial index for worker queries
CREATE INDEX "notifications_status_worker_idx"
  ON "notifications"("status") WHERE "status" IN ('QUEUED', 'RETRYING');

CREATE INDEX "notifications_correlationId_idx"  ON "notifications"("correlationId");
CREATE INDEX "notifications_idempotencyKey_idx" ON "notifications"("idempotencyKey");
CREATE INDEX "notifications_nextRetryAt_idx"    ON "notifications"("nextRetryAt");

-- ─── 5. Ongoing partition maintenance ────────────────────────────────────────────

-- Idempotent: creates any missing partitions from `months_back` months ago to
-- `months_ahead` months ahead. Returns how many were created. Called by the
-- application's PartitionMaintenanceJob at startup and daily.
CREATE OR REPLACE FUNCTION ensure_notification_partitions(months_back integer DEFAULT 0,
                                                          months_ahead integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  m date := (date_trunc('month', now() AT TIME ZONE 'UTC') - make_interval(months => months_back))::date;
  last_month date := (date_trunc('month', now() AT TIME ZONE 'UTC') + make_interval(months => months_ahead))::date;
  created integer := 0;
  part_name text;
BEGIN
  WHILE m <= last_month LOOP
    part_name := format('notifications_y%sm%s', to_char(m, 'YYYY'), to_char(m, 'MM'));
    IF to_regclass(part_name) IS NULL THEN
      PERFORM create_notification_partition('notifications'::regclass, m);
      created := created + 1;
    END IF;
    m := (m + interval '1 month')::date;
  END LOOP;
  RETURN created;
END;
$$;
