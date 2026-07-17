CREATE TABLE "ai_usage_logs" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "feature" TEXT NOT NULL,
  "model" TEXT NOT NULL,
  "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0,
  "totalTokens" INTEGER NOT NULL DEFAULT 0,
  "durationMs" INTEGER NOT NULL,
  "statusCode" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ai_usage_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_usage_logs_userId_createdAt_idx" ON "ai_usage_logs"("userId", "createdAt");
CREATE INDEX "ai_usage_logs_roomId_createdAt_idx" ON "ai_usage_logs"("roomId", "createdAt");
CREATE INDEX "ai_usage_logs_feature_createdAt_idx" ON "ai_usage_logs"("feature", "createdAt");

ALTER TABLE "ai_usage_logs"
  ADD CONSTRAINT "ai_usage_logs_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "chat_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_usage_logs"
  ADD CONSTRAINT "ai_usage_logs_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "chat_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
