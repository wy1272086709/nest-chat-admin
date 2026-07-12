ALTER TABLE "chat_messages"
  ADD COLUMN IF NOT EXISTS "clientMessageId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "chat_messages_senderId_clientMessageId_key"
  ON "chat_messages"("senderId", "clientMessageId");

CREATE TABLE IF NOT EXISTS "message_sync_states" (
  "id" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "lastDeliveredId" TEXT,
  "lastDeliveredAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "message_sync_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "message_sync_states_roomId_userId_key"
  ON "message_sync_states"("roomId", "userId");

CREATE INDEX IF NOT EXISTS "message_sync_states_userId_updatedAt_idx"
  ON "message_sync_states"("userId", "updatedAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'message_sync_states_roomId_fkey'
  ) THEN
    ALTER TABLE "message_sync_states"
      ADD CONSTRAINT "message_sync_states_roomId_fkey"
      FOREIGN KEY ("roomId") REFERENCES "chat_rooms"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'message_sync_states_userId_fkey'
  ) THEN
    ALTER TABLE "message_sync_states"
      ADD CONSTRAINT "message_sync_states_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "chat_users"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
