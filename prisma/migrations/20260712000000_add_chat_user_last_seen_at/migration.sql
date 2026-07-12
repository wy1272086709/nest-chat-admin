-- Add last seen time for chat users.
ALTER TABLE "chat_users" ADD COLUMN "lastSeenAt" TIMESTAMP(3);

CREATE INDEX "chat_users_lastSeenAt_idx" ON "chat_users"("lastSeenAt");
