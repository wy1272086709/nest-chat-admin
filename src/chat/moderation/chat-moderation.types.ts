export const CHAT_MODERATION_EVENT_TYPE = 'chat.moderation.requested' as const;
export const CHAT_MODERATION_EVENT_VERSION = 1 as const;

export type ChatModerationMode = 'sync' | 'async' | 'shadow' | 'off';

export type MessageModerationRequestedV1 = {
  eventId: string;
  eventType: typeof CHAT_MODERATION_EVENT_TYPE;
  version: typeof CHAT_MODERATION_EVENT_VERSION;
  messageId: string;
  userId: string;
  roomId: string;
  requestedAt: string;
  policyVersion: string;
};
