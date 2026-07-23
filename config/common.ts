const buildRabbitmqUrl = () => {
  if (process.env.RABBITMQ_URL) {
    return process.env.RABBITMQ_URL;
  }

  const username =
    process.env.RABBITMQ_USERNAME ?? process.env.ADMIN_LOGIN ?? "guest";
  const password =
    process.env.RABBITMQ_PASSWORD ?? process.env.ADMIN_PASSWORD ?? "guest";
  const host = process.env.RABBITMQ_HOST ?? "127.0.0.1";
  const port = process.env.RABBITMQ_PORT ?? "5672";
  const vhost = process.env.RABBITMQ_VHOST;
  const encodedAuth = `${encodeURIComponent(username)}:${encodeURIComponent(
    password,
  )}`;
  const encodedVhost = vhost ? `/${encodeURIComponent(vhost)}` : "";

  return `amqp://${encodedAuth}@${host}:${port}${encodedVhost}`;
};

export default () => ({
  app: {
    name: process.env.APP_NAME ?? "Nestjs-Server",
    env: process.env.NODE_ENV ?? "development",
    port: Number(process.env.APP_PORT ?? 3000),
    apiPrefix: process.env.APP_API_PREFIX ?? "api",
  },
  database: {
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USERNAME ?? "root",
    password: process.env.DB_PASSWORD ?? "",
    name: process.env.DB_NAME ?? "public",
    synchronize: process.env.DB_SYNC === "true",
    logging: process.env.DB_LOGGING === "true",
  },
  jwt: {
    secret: process.env.JWT_SECRET ?? "secret-key",
    expiresIn: process.env.JWT_EXPIRES_IN ?? "7d",
  },
  redis: {
    host: process.env.REDIS_HOST ?? "127.0.0.1",
    port: Number(process.env.REDIS_PORT ?? 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB ?? 0),
  },
  log: {
    level: process.env.LOG_LEVEL ?? "info",
    dir: process.env.LOG_DIR ?? "logs",
    consoleEnabled: process.env.LOG_CONSOLE_ENABLED !== "false",
    fileEnabled: process.env.LOG_FILE_ENABLED !== "false",
    healthLogEnabled: process.env.LOG_HEALTH_LOG_ENABLED === "true",
    dependencyCheckIntervalMs: Number(
      process.env.LOG_DEPENDENCY_CHECK_INTERVAL_MS ?? 30000,
    ),
    maxFileSizeMb: Number(process.env.LOG_MAX_FILE_SIZE_MB ?? 20),
    retentionDays: Number(process.env.LOG_RETENTION_DAYS ?? 30),
  },
  email: {
    host: process.env.EMAIL_HOST ?? "smtp.qq.com",
    port: Number(process.env.EMAIL_PORT ?? 587),
    secure: process.env.EMAIL_SECURE === "true",
    user: process.env.EMAIL_USER ?? "1272086709@qq.com",
    pass: process.env.EMAIL_PASSWORD ?? "pvwgbflzsactfibg",
  },
  minio: {
    endPoint:
      process.env.MINIO_ENDPOINT ?? process.env.MINIO_HOST ?? "localhost",
    port: Number(process.env.MINIO_PORT ?? 9000),
    useSSL: process.env.MINIO_USE_SSL === "true",
    accessKey:
      process.env.MINIO_ACCESS_KEY ??
      process.env.MINIO_ROOT_USER ??
      process.env.ADMIN_LOGIN ??
      "admin",
    secretKey:
      process.env.MINIO_SECRET_KEY ??
      process.env.MINIO_ROOT_PASSWORD ??
      process.env.ADMIN_PASSWORD ??
      "admin123456",
    publicServerUrl: process.env.MINIO_SERVER_URL,
  },
  rabbitmq: {
    url: buildRabbitmqUrl(),
    mailConsumerEnabled: process.env.RABBITMQ_MAIL_CONSUMER_ENABLED !== "false",
    mailVerificationRetryDelayMs: Number(
      process.env.MAIL_RETRY_DELAY_MS ?? 10000,
    ),
    mailVerificationMaxRetry: Number(process.env.MAIL_MAX_RETRY ?? 3),
    mailVerificationPrefetch: Number(process.env.MAIL_PREFETCH ?? 5),
    chatModerationPublisherEnabled:
      process.env.CHAT_MODERATION_PUBLISHER_ENABLED !== "false",
    chatModerationConsumerEnabled:
      process.env.CHAT_MODERATION_CONSUMER_ENABLED !== "false",
    chatModerationRetryDelayMs: Number(
      process.env.CHAT_MODERATION_RETRY_DELAY_MS ?? 10000,
    ),
    chatModerationMaxRetry: Number(process.env.CHAT_MODERATION_MAX_RETRY ?? 3),
    chatModerationPrefetch: Number(process.env.CHAT_MODERATION_PREFETCH ?? 5),
    moderationOutboxPollMs: Number(
      process.env.MODERATION_OUTBOX_POLL_MS ?? 1000,
    ),
    moderationOutboxBatchSize: Number(
      process.env.MODERATION_OUTBOX_BATCH_SIZE ?? 50,
    ),
    moderationOutboxLockMs: Number(
      process.env.MODERATION_OUTBOX_LOCK_MS ?? 30000,
    ),
    moderationOutboxMaxAttempts: Number(
      process.env.MODERATION_OUTBOX_MAX_ATTEMPTS ?? 10,
    ),
    moderationOutboxRetentionDays: Number(
      process.env.MODERATION_OUTBOX_RETENTION_DAYS ?? 7,
    ),
  },
  ai: {
    apiKey: process.env.OPENAI_API_KEY,
    baseUrl: process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    model: process.env.MODEL_NAME ?? "gpt-4.1-mini",
    apiMode: process.env.AI_API_MODE ?? "auto",
    timeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 30000),
    maxInputCharacters: Number(process.env.AI_MAX_INPUT_CHARACTERS ?? 30000),
    rateLimitWindowMs: Number(process.env.AI_RATE_LIMIT_WINDOW_MS ?? 5000),
    rateLimitMaxRequests: Number(process.env.AI_RATE_LIMIT_MAX_REQUESTS ?? 2),
    moderationEnabled: process.env.AI_MODERATION_ENABLED !== "false",
    moderationModel: process.env.AI_MODERATION_MODEL ?? process.env.MODEL_NAME,
    moderationTimeoutMs: Number(process.env.AI_MODERATION_TIMEOUT_MS ?? 5000),
    moderationMaxCharacters: Number(
      process.env.AI_MODERATION_MAX_CHARACTERS ?? 4000,
    ),
    moderationMode: process.env.AI_MODERATION_MODE ?? "async",
    moderationPolicyVersion: process.env.AI_MODERATION_POLICY_VERSION ?? "v1",
    moderationActionsEnabled:
      process.env.AI_MODERATION_ACTIONS_ENABLED !== "false",
    moderationEnforcementEnabled:
      process.env.AI_MODERATION_ENFORCEMENT_ENABLED === "true",
    moderationViolationWindowMs: Number(
      process.env.AI_MODERATION_VIOLATION_WINDOW_MS ?? 86400000,
    ),
    moderationWarningScore: Number(
      process.env.AI_MODERATION_WARNING_SCORE ?? 3,
    ),
    moderationMuteScore: Number(process.env.AI_MODERATION_MUTE_SCORE ?? 6),
    moderationMuteDurationMs: Number(
      process.env.AI_MODERATION_MUTE_DURATION_MS ?? 600000,
    ),
  },
});
