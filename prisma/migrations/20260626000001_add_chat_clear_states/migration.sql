CREATE TABLE "chat_clear_states" (
  "id" TEXT NOT NULL,
  "roomId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "clearedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "chat_clear_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_clear_states_roomId_userId_key" ON "chat_clear_states"("roomId", "userId");
CREATE INDEX "chat_clear_states_userId_clearedAt_idx" ON "chat_clear_states"("userId", "clearedAt");

ALTER TABLE "chat_clear_states"
  ADD CONSTRAINT "chat_clear_states_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "chat_rooms"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chat_clear_states"
  ADD CONSTRAINT "chat_clear_states_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "chat_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
