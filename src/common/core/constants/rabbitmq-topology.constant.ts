export const RABBITMQ_EXCHANGES = {
  events: 'app.events',
  retry: 'app.events.retry',
  deadLetter: 'app.events.dlx',
} as const;

export const MAIL_VERIFICATION_TOPOLOGY = {
  queue: 'mail.verification.send.queue',
  retryQueue: 'mail.verification.send.retry.queue',
  deadLetterQueue: 'mail.verification.send.dlq',
  routingKey: 'mail.verification.send',
  retryRoutingKey: 'mail.verification.send.retry',
  deadLetterRoutingKey: 'mail.verification.send.dlq',
} as const;

export const CHAT_MODERATION_TOPOLOGY = {
  queue: 'chat.moderation.requested.queue',
  retryQueue: 'chat.moderation.requested.retry.queue',
  deadLetterQueue: 'chat.moderation.requested.dlq',
  routingKey: 'chat.moderation.requested',
  retryRoutingKey: 'chat.moderation.requested.retry',
  deadLetterRoutingKey: 'chat.moderation.requested.dlq',
} as const;
