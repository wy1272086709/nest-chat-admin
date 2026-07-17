CREATE TYPE "ChatRestrictionStatus" AS ENUM ('ACTIVE', 'REVOKED');

CREATE TABLE "user_violations" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "moderationId" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "severity" INTEGER NOT NULL,
  "score" INTEGER NOT NULL,
  "policyVersion" TEXT NOT NULL,
  "action" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_violations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_violations_moderationId_key" ON "user_violations"("moderationId");
CREATE INDEX "user_violations_userId_createdAt_idx" ON "user_violations"("userId", "createdAt");

CREATE TABLE "chat_user_restrictions" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "status" "ChatRestrictionStatus" NOT NULL DEFAULT 'ACTIVE',
  "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "reason" TEXT NOT NULL,
  "sourceModerationId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "chat_user_restrictions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_user_restrictions_sourceModerationId_key"
  ON "chat_user_restrictions"("sourceModerationId");
CREATE INDEX "chat_user_restrictions_userId_status_expiresAt_idx"
  ON "chat_user_restrictions"("userId", "status", "expiresAt");

ALTER TABLE "user_violations"
  ADD CONSTRAINT "user_violations_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "chat_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_violations"
  ADD CONSTRAINT "user_violations_moderationId_fkey"
  FOREIGN KEY ("moderationId") REFERENCES "message_moderations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chat_user_restrictions"
  ADD CONSTRAINT "chat_user_restrictions_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "chat_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
