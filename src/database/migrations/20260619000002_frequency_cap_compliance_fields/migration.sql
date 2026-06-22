-- Migration: 20260619000002_frequency_cap_compliance_fields
-- Adds frequency_cap_checked and frequency_cap_result to the notifications table
-- so the GET /notifications/:id compliance block fully matches spec Appendix A.

ALTER TABLE "notifications"
  ADD COLUMN IF NOT EXISTS "frequencyCapChecked" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS "frequencyCapResult" VARCHAR(30);