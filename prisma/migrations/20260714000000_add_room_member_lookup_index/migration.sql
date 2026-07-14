CREATE INDEX IF NOT EXISTS "chat_room_members_userId_status_idx"
ON "chat_room_members"("userId", "status");
