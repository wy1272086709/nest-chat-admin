CREATE TABLE "chat_friendships" (
  "id" TEXT NOT NULL,
  "senderId" TEXT NOT NULL,
  "receiverId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "chat_friendships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_friendships_senderId_receiverId_key" ON "chat_friendships"("senderId", "receiverId");
CREATE INDEX "chat_friendships_senderId_idx" ON "chat_friendships"("senderId");
CREATE INDEX "chat_friendships_receiverId_idx" ON "chat_friendships"("receiverId");

ALTER TABLE "chat_friendships"
  ADD CONSTRAINT "chat_friendships_senderId_fkey"
  FOREIGN KEY ("senderId") REFERENCES "chat_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chat_friendships"
  ADD CONSTRAINT "chat_friendships_receiverId_fkey"
  FOREIGN KEY ("receiverId") REFERENCES "chat_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
