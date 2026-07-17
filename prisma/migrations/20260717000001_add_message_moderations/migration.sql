CREATE TABLE "message_moderations" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "messageId" TEXT,
  "clientMessageId" TEXT,
  "decision" TEXT NOT NULL,
  "categories" JSONB NOT NULL,
  "confidence" DOUBLE PRECISION,
  "reason" TEXT,
  "reviewStatus" TEXT NOT NULL,
  "model" TEXT,
  "statusCode" INTEGER NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "message_moderations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "message_moderations_userId_createdAt_idx" ON "message_moderations"("userId", "createdAt");
CREATE INDEX "message_moderations_roomId_createdAt_idx" ON "message_moderations"("roomId", "createdAt");
CREATE INDEX "message_moderations_decision_reviewStatus_createdAt_idx" ON "message_moderations"("decision", "reviewStatus", "createdAt");
CREATE INDEX "message_moderations_messageId_idx" ON "message_moderations"("messageId");
CREATE INDEX "message_moderations_userId_clientMessageId_idx" ON "message_moderations"("userId", "clientMessageId");

ALTER TABLE "message_moderations"
  ADD CONSTRAINT "message_moderations_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "chat_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "message_moderations"
  ADD CONSTRAINT "message_moderations_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "chat_rooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "message_moderations"
  ADD CONSTRAINT "message_moderations_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "chat_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;
