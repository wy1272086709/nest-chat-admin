SELECT
  "id",
  "senderId",
  "receiverId",
  "createdAt"
FROM "chat_friendships"
LIMIT 1;

SELECT
  "id",
  "roomId",
  "userId",
  "clearedAt"
FROM "chat_clear_states"
LIMIT 1;
