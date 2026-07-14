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
