-- Migration: 20260619000001_brin_gin_partial_indexes
-- Adds the three spec-required index types missing from the initial migration:
--   1. BRIN index on notifications.created_at (spec Section A8.2: "BRIN index on created_at
--      for time-range scans on the partitioned table")
--   2. GIN index on notifications.personalisation_data (spec Section A8.2: "GIN index on
--      personalisation_data for JSONB queries")
--   3. Correct partial index on notifications.status WHERE IN ('QUEUED','RETRYING')
--      (spec Section A8.2: "Partial index on (status) WHERE status IN ('QUEUED','RETRYING')
--      for worker queries")
--
-- The initial migration created a plain B-tree index on created_at and a plain B-tree index
-- on status with no WHERE clause. This migration drops those and replaces them.

-- 1. Drop the plain B-tree created_at index and replace with BRIN
DROP INDEX IF EXISTS "notifications_createdAt_idx";
CREATE INDEX "notifications_createdAt_brin_idx"
  ON "notifications" USING BRIN ("createdAt");

-- 2. Add GIN index on personalisation_data JSONB column
CREATE INDEX "notifications_personalisationData_gin_idx"
  ON "notifications" USING GIN ("personalisationData");

-- 3. Drop plain status index and replace with correct partial index
DROP INDEX IF EXISTS "notifications_status_idx";
CREATE INDEX "notifications_status_worker_idx"
  ON "notifications" ("status")
  WHERE "status" IN ('QUEUED', 'RETRYING');

-- NOTE ON TABLE PARTITIONING:
-- The spec (Section A8.1) requires PARTITION BY RANGE (created_at).
-- PostgreSQL requires the table to be created as partitioned from the start —
-- an existing populated table cannot be converted to a partitioned table in-place
-- without recreating it. In a real production migration this would be done via:
--   1. CREATE TABLE notifications_partitioned (LIKE notifications) PARTITION BY RANGE ("createdAt");
--   2. CREATE TABLE notifications_2026_06 PARTITION OF notifications_partitioned
--        FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
--   3. INSERT INTO notifications_partitioned SELECT * FROM notifications;
--   4. ALTER TABLE notifications RENAME TO notifications_old;
--   5. ALTER TABLE notifications_partitioned RENAME TO notifications;
-- This is documented in docs/database-schema.md as a production deployment step
-- requiring a maintenance window. The BRIN and GIN indexes above apply to the
-- current non-partitioned table and would be recreated per-partition after the
-- partition migration is executed in production.