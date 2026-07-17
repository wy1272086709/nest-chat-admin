CREATE TYPE "MessageModerationStatus" AS ENUM (
  'PENDING',
  'PASSED',
  'REVIEW',
  'REJECTED',
  'DEGRADED',
  'NOT_APPLICABLE'
);

CREATE TYPE "ModerationOutboxStatus" AS ENUM (
  'PENDING',
  'PUBLISHING',
  'PUBLISHED',
  'RETRY',
  'FAILED'
);

ALTER TABLE "chat_messages"
  ADD COLUMN "moderationStatus" "MessageModerationStatus" NOT NULL DEFAULT 'NOT_APPLICABLE',
  ADD COLUMN "moderatedAt" TIMESTAMP(3);

ALTER TABLE "message_moderations"
  ADD COLUMN "eventId" TEXT,
  ADD COLUMN "policyVersion" TEXT NOT NULL DEFAULT 'v1';

CREATE UNIQUE INDEX "message_moderations_eventId_key" ON "message_moderations"("eventId");

CREATE TABLE "moderation_outbox" (
  "id" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "ModerationOutboxStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lockedAt" TIMESTAMP(3),
  "lockedBy" TEXT,
  "publishedAt" TIMESTAMP(3),
  "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "moderation_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "moderation_outbox_aggregateId_eventType_key"
  ON "moderation_outbox"("aggregateId", "eventType");
CREATE INDEX "moderation_outbox_status_nextAttemptAt_createdAt_idx"
  ON "moderation_outbox"("status", "nextAttemptAt", "createdAt");
CREATE INDEX "moderation_outbox_lockedAt_idx" ON "moderation_outbox"("lockedAt");
