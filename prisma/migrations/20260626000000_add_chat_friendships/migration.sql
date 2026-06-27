CREATE TABLE "chat_friendships" (
  "id" TEXT NOT NULL,
  "userAId" TEXT NOT NULL,
  "userBId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "chat_friendships_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "chat_friendships_userAId_userBId_key" ON "chat_friendships"("userAId", "userBId");
CREATE INDEX "chat_friendships_userAId_idx" ON "chat_friendships"("userAId");
CREATE INDEX "chat_friendships_userBId_idx" ON "chat_friendships"("userBId");

ALTER TABLE "chat_friendships"
  ADD CONSTRAINT "chat_friendships_userAId_fkey"
  FOREIGN KEY ("userAId") REFERENCES "chat_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "chat_friendships"
  ADD CONSTRAINT "chat_friendships_userBId_fkey"
  FOREIGN KEY ("userBId") REFERENCES "chat_users"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
