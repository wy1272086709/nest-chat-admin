DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'FavoriteType') THEN
    CREATE TYPE "FavoriteType" AS ENUM ('MESSAGE', 'IMAGE', 'VIDEO', 'FILE', 'CHAT_RECORD');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "chat_favorites" (
  "id" TEXT NOT NULL,
  "type" "FavoriteType" NOT NULL DEFAULT 'MESSAGE',
  "targetId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "sourceType" TEXT,
  "sourceId" TEXT,
  "sourceName" TEXT,
  "roomId" TEXT,
  "title" TEXT,
  "content" TEXT,
  "fileUrl" TEXT,
  "fileName" TEXT,
  "fileSize" INTEGER,
  "fileType" TEXT,
  "thumbnailUrl" TEXT,
  "mediaWidth" INTEGER,
  "mediaHeight" INTEGER,
  "duration" INTEGER,
  "extra" JSONB,
  "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "chat_favorites_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "chat_favorites"
  DROP CONSTRAINT IF EXISTS "chat_favorites_userId_targetType_targetId_key";

ALTER TABLE "chat_favorites"
  ADD COLUMN IF NOT EXISTS "type" "FavoriteType",
  ADD COLUMN IF NOT EXISTS "sourceType" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceId" TEXT,
  ADD COLUMN IF NOT EXISTS "sourceName" TEXT,
  ADD COLUMN IF NOT EXISTS "roomId" TEXT,
  ADD COLUMN IF NOT EXISTS "title" TEXT,
  ADD COLUMN IF NOT EXISTS "content" TEXT,
  ADD COLUMN IF NOT EXISTS "fileUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "fileName" TEXT,
  ADD COLUMN IF NOT EXISTS "fileSize" INTEGER,
  ADD COLUMN IF NOT EXISTS "fileType" TEXT,
  ADD COLUMN IF NOT EXISTS "thumbnailUrl" TEXT,
  ADD COLUMN IF NOT EXISTS "mediaWidth" INTEGER,
  ADD COLUMN IF NOT EXISTS "mediaHeight" INTEGER,
  ADD COLUMN IF NOT EXISTS "duration" INTEGER,
  ADD COLUMN IF NOT EXISTS "extra" JSONB,
  ADD COLUMN IF NOT EXISTS "collectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'chat_favorites'
      AND column_name = 'targetType'
  ) THEN
    UPDATE "chat_favorites"
    SET "type" = CASE
      WHEN LOWER("targetType") = 'image' THEN 'IMAGE'::"FavoriteType"
      WHEN LOWER("targetType") = 'video' THEN 'VIDEO'::"FavoriteType"
      WHEN LOWER("targetType") = 'file' THEN 'FILE'::"FavoriteType"
      WHEN LOWER("targetType") IN ('chat_record', 'chat-record', 'record') THEN 'CHAT_RECORD'::"FavoriteType"
      ELSE 'MESSAGE'::"FavoriteType"
    END
    WHERE "type" IS NULL;

    ALTER TABLE "chat_favorites" DROP COLUMN "targetType";
  END IF;
END $$;

UPDATE "chat_favorites"
SET "type" = 'MESSAGE'::"FavoriteType"
WHERE "type" IS NULL;

UPDATE "chat_favorites"
SET
  "collectedAt" = COALESCE("collectedAt", CURRENT_TIMESTAMP),
  "createdAt" = COALESCE("createdAt", CURRENT_TIMESTAMP),
  "updatedAt" = COALESCE("updatedAt", CURRENT_TIMESTAMP)
WHERE "collectedAt" IS NULL
  OR "createdAt" IS NULL
  OR "updatedAt" IS NULL;

ALTER TABLE "chat_favorites"
  ALTER COLUMN "type" SET NOT NULL,
  ALTER COLUMN "type" SET DEFAULT 'MESSAGE',
  ALTER COLUMN "collectedAt" SET NOT NULL,
  ALTER COLUMN "collectedAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "createdAt" SET NOT NULL,
  ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "updatedAt" SET NOT NULL,
  ALTER COLUMN "updatedAt" SET DEFAULT CURRENT_TIMESTAMP;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'chat_favorites_userId_fkey'
  ) THEN
    ALTER TABLE "chat_favorites"
      ADD CONSTRAINT "chat_favorites_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "chat_users"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "chat_favorites_userId_type_targetId_key" ON "chat_favorites"("userId", "type", "targetId");
CREATE INDEX IF NOT EXISTS "chat_favorites_userId_type_collectedAt_idx" ON "chat_favorites"("userId", "type", "collectedAt");
CREATE INDEX IF NOT EXISTS "chat_favorites_sourceType_sourceId_idx" ON "chat_favorites"("sourceType", "sourceId");
