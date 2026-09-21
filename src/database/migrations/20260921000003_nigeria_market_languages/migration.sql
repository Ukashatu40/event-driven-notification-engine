-- Migration: 20260921000003_nigeria_market_languages
-- Adds the Nigerian market: four languages (Nigerian Pidgin, Hausa, Yoruba, Igbo)
-- and a per-user market (IN | NG) that selects currency, regulator, DND registry
-- and SMS providers. Existing users stay on IN.

ALTER TYPE "Language" ADD VALUE IF NOT EXISTS 'PCM';
ALTER TYPE "Language" ADD VALUE IF NOT EXISTS 'HA';
ALTER TYPE "Language" ADD VALUE IF NOT EXISTS 'YO';
ALTER TYPE "Language" ADD VALUE IF NOT EXISTS 'IG';

CREATE TYPE "Market" AS ENUM ('IN', 'NG');

ALTER TABLE "users" ADD COLUMN "market" "Market" NOT NULL DEFAULT 'IN';
