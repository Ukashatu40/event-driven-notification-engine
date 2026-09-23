-- CreateEnum
CREATE TYPE "NotificationStatus" AS ENUM ('CREATED', 'ENRICHED', 'ROUTED', 'QUEUED', 'SENT', 'DELIVERED', 'READ', 'CAPPED', 'QUIET', 'DND', 'FAILED', 'RETRYING', 'DLQ', 'DEDUPLICATED', 'BOUNCED');

-- CreateEnum
CREATE TYPE "MessageClassification" AS ENUM ('TRANSACTIONAL', 'PROMOTIONAL');

-- CreateEnum
CREATE TYPE "Language" AS ENUM ('EN', 'HI', 'MR', 'TA', 'TE');

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('BASIC', 'PREMIUM', 'HNI');

-- CreateEnum
CREATE TYPE "RiskProfile" AS ENUM ('CONSERVATIVE', 'MODERATE', 'AGGRESSIVE');

-- CreateEnum
CREATE TYPE "DndStatus" AS ENUM ('REGISTERED', 'NOT_REGISTERED');

-- CreateEnum
CREATE TYPE "DigestMode" AS ENUM ('IMMEDIATE', 'HOURLY', 'DAILY');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "phone" VARCHAR(20) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "language" "Language" NOT NULL DEFAULT 'EN',
    "timezone" VARCHAR(50) NOT NULL DEFAULT 'Asia/Kolkata',
    "accountType" "AccountType" NOT NULL DEFAULT 'BASIC',
    "riskProfile" "RiskProfile" NOT NULL DEFAULT 'MODERATE',
    "dndStatus" "DndStatus" NOT NULL DEFAULT 'NOT_REGISTERED',
    "dndCategories" TEXT[],
    "quietHoursStart" VARCHAR(5) NOT NULL DEFAULT '21:00',
    "quietHoursEnd" VARCHAR(5) NOT NULL DEFAULT '08:00',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL,
    "eventType" VARCHAR(10) NOT NULL,
    "eventId" VARCHAR(100) NOT NULL,
    "userId" UUID NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "status" "NotificationStatus" NOT NULL DEFAULT 'CREATED',
    "templateId" VARCHAR(50) NOT NULL,
    "templateVersion" INTEGER NOT NULL DEFAULT 1,
    "personalisationData" JSONB NOT NULL,
    "renderedContent" JSONB,
    "provider" VARCHAR(30),
    "externalId" VARCHAR(100),
    "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
    "maxRetries" INTEGER NOT NULL DEFAULT 3,
    "nextRetryAt" TIMESTAMPTZ,
    "deliveredAt" TIMESTAMPTZ,
    "readAt" TIMESTAMPTZ,
    "failedReason" TEXT,
    "costPaisa" INTEGER,
    "metadata" JSONB,
    "correlationId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(255),
    "dndChecked" BOOLEAN NOT NULL DEFAULT false,
    "dndCheckTimestamp" TIMESTAMPTZ,
    "dndResult" VARCHAR(20),
    "classification" "MessageClassification" NOT NULL DEFAULT 'TRANSACTIONAL',
    "regulatoryOverride" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_state_log" (
    "id" BIGSERIAL NOT NULL,
    "notificationId" UUID NOT NULL,
    "fromStatus" VARCHAR(20),
    "toStatus" VARCHAR(20) NOT NULL,
    "actor" VARCHAR(50) NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_state_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "delivery_attempts" (
    "id" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "provider" VARCHAR(30) NOT NULL,
    "status" VARCHAR(20) NOT NULL,
    "requestPayload" JSONB,
    "responsePayload" JSONB,
    "errorCode" VARCHAR(50),
    "errorMessage" TEXT,
    "latencyMs" INTEGER,
    "costPaisa" INTEGER,
    "attemptedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dead_letter_queue" (
    "id" UUID NOT NULL,
    "notificationId" UUID NOT NULL,
    "originalEvent" JSONB NOT NULL,
    "failureReason" TEXT NOT NULL,
    "retryCount" INTEGER NOT NULL,
    "lastError" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedBy" VARCHAR(50),
    "resolvedAt" TIMESTAMPTZ,
    "resolutionAction" VARCHAR(50),
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "dead_letter_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "templates" (
    "id" VARCHAR(50) NOT NULL,
    "eventType" VARCHAR(10) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isAbVariant" BOOLEAN NOT NULL DEFAULT false,
    "abWeight" INTEGER NOT NULL DEFAULT 100,
    "channels" JSONB NOT NULL,
    "localisations" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_preferences" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "eventCategory" VARCHAR(10) NOT NULL,
    "eventType" VARCHAR(10),
    "channel" VARCHAR(20) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "quietHoursOverride" BOOLEAN NOT NULL DEFAULT false,
    "digestMode" "DigestMode" NOT NULL DEFAULT 'IMMEDIATE',
    "priorityOverride" INTEGER,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "user_preferences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_segments" (
    "id" UUID NOT NULL,
    "name" VARCHAR(50) NOT NULL,
    "description" TEXT,
    "rules" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_segment_memberships" (
    "userId" UUID NOT NULL,
    "segmentId" UUID NOT NULL,
    "addedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_segment_memberships_pkey" PRIMARY KEY ("userId","segmentId")
);

-- CreateTable
CREATE TABLE "consent_records" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "consentType" VARCHAR(30) NOT NULL,
    "consentText" TEXT NOT NULL,
    "ipAddress" VARCHAR(45) NOT NULL,
    "userAgent" TEXT,
    "granted" BOOLEAN NOT NULL,
    "grantedAt" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "consent_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_health" (
    "id" UUID NOT NULL,
    "provider" VARCHAR(30) NOT NULL,
    "channel" VARCHAR(20) NOT NULL,
    "circuitState" VARCHAR(15) NOT NULL DEFAULT 'CLOSED',
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "successCount" INTEGER NOT NULL DEFAULT 0,
    "lastFailureAt" TIMESTAMPTZ,
    "lastSuccessAt" TIMESTAMPTZ,
    "updatedAt" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "provider_health_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_phone_key" ON "users"("phone");

-- CreateIndex
CREATE INDEX "users_phone_idx" ON "users"("phone");

-- CreateIndex
CREATE INDEX "users_email_idx" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_accountType_idx" ON "users"("accountType");

-- CreateIndex
CREATE INDEX "notifications_userId_status_channel_idx" ON "notifications"("userId", "status", "channel");

-- CreateIndex
CREATE INDEX "notifications_status_idx" ON "notifications"("status");

-- CreateIndex
CREATE INDEX "notifications_eventType_createdAt_idx" ON "notifications"("eventType", "createdAt");

-- CreateIndex
CREATE INDEX "notifications_correlationId_idx" ON "notifications"("correlationId");

-- CreateIndex
CREATE INDEX "notifications_idempotencyKey_idx" ON "notifications"("idempotencyKey");

-- CreateIndex
CREATE INDEX "notifications_nextRetryAt_idx" ON "notifications"("nextRetryAt");

-- CreateIndex
CREATE INDEX "notifications_createdAt_idx" ON "notifications"("createdAt");

-- CreateIndex
CREATE INDEX "notification_state_log_notificationId_idx" ON "notification_state_log"("notificationId");

-- CreateIndex
CREATE INDEX "notification_state_log_createdAt_idx" ON "notification_state_log"("createdAt");

-- CreateIndex
CREATE INDEX "delivery_attempts_notificationId_idx" ON "delivery_attempts"("notificationId");

-- CreateIndex
CREATE INDEX "delivery_attempts_provider_attemptedAt_idx" ON "delivery_attempts"("provider", "attemptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "dead_letter_queue_notificationId_key" ON "dead_letter_queue"("notificationId");

-- CreateIndex
CREATE INDEX "dead_letter_queue_resolved_createdAt_idx" ON "dead_letter_queue"("resolved", "createdAt");

-- CreateIndex
CREATE INDEX "templates_eventType_isActive_idx" ON "templates"("eventType", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "templates_eventType_version_key" ON "templates"("eventType", "version");

-- CreateIndex
CREATE INDEX "user_preferences_userId_idx" ON "user_preferences"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_preferences_userId_eventCategory_channel_key" ON "user_preferences"("userId", "eventCategory", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "user_segments_name_key" ON "user_segments"("name");

-- CreateIndex
CREATE INDEX "consent_records_userId_channel_idx" ON "consent_records"("userId", "channel");

-- CreateIndex
CREATE INDEX "consent_records_grantedAt_idx" ON "consent_records"("grantedAt");

-- CreateIndex
CREATE UNIQUE INDEX "provider_health_provider_key" ON "provider_health"("provider");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_state_log" ADD CONSTRAINT "notification_state_log_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "delivery_attempts" ADD CONSTRAINT "delivery_attempts_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dead_letter_queue" ADD CONSTRAINT "dead_letter_queue_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_preferences" ADD CONSTRAINT "user_preferences_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_segment_memberships" ADD CONSTRAINT "user_segment_memberships_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_segment_memberships" ADD CONSTRAINT "user_segment_memberships_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "user_segments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_records" ADD CONSTRAINT "consent_records_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
