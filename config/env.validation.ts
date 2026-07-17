import Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'production')
    .default('development'),
  APP_NAME: Joi.string().default('nextjs-server'),
  APP_PORT: Joi.number().port().default(3000),
  APP_API_PREFIX: Joi.string()
    .pattern(/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/)
    .default('api'),

  DB_HOST: Joi.string().required(),
  DB_PORT: Joi.number().port().default(5432),
  DB_USERNAME: Joi.string().required(),
  DB_PASSWORD: Joi.string().allow('').default(''),
  DB_NAME: Joi.string().required(),
  DB_SYNC: Joi.boolean().truthy('true').falsy('false').default(false),
  DB_LOGGING: Joi.boolean().truthy('true').falsy('false').default(false),

  JWT_SECRET: Joi.string().min(32).required(),
  JWT_EXPIRES_IN: Joi.string().default('7d'),

  REDIS_HOST: Joi.string().required(),
  REDIS_PORT: Joi.number().port().default(6379),
  REDIS_PASSWORD: Joi.string().allow('').optional(),
  REDIS_DB: Joi.number().integer().min(0).default(0),

  OPENAI_API_KEY: Joi.string().allow('').optional(),
  OPENAI_BASE_URL: Joi.string().uri().default('https://api.openai.com/v1'),
  MODEL_NAME: Joi.string().default('gpt-4.1-mini'),
  AI_API_MODE: Joi.string()
    .valid('auto', 'responses', 'chat-completions')
    .default('auto'),
  AI_TIMEOUT_MS: Joi.number().integer().min(1000).default(30000),
  AI_MAX_INPUT_CHARACTERS: Joi.number().integer().min(1000).default(30000),
  AI_RATE_LIMIT_WINDOW_MS: Joi.number().integer().min(0).default(5000),
  AI_RATE_LIMIT_MAX_REQUESTS: Joi.number().integer().min(1).default(2),
  AI_MODERATION_ENABLED: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .default(true),
  AI_MODERATION_MODEL: Joi.string().allow('').optional(),
  AI_MODERATION_TIMEOUT_MS: Joi.number().integer().min(1000).default(5000),
  AI_MODERATION_MAX_CHARACTERS: Joi.number().integer().min(100).default(4000),
  AI_MODERATION_MODE: Joi.string()
    .valid('sync', 'async', 'shadow', 'off')
    .default('async'),
  AI_MODERATION_POLICY_VERSION: Joi.string().default('v1'),
  AI_MODERATION_ACTIONS_ENABLED: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .default(false),
  AI_MODERATION_ENFORCEMENT_ENABLED: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .default(false),
  AI_MODERATION_VIOLATION_WINDOW_MS: Joi.number()
    .integer()
    .min(60000)
    .default(86400000),
  AI_MODERATION_WARNING_SCORE: Joi.number().integer().min(1).default(3),
  AI_MODERATION_MUTE_SCORE: Joi.number().integer().min(1).default(6),
  AI_MODERATION_MUTE_DURATION_MS: Joi.number()
    .integer()
    .min(60000)
    .default(600000),

  CHAT_MODERATION_PUBLISHER_ENABLED: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .default(true),
  CHAT_MODERATION_CONSUMER_ENABLED: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .default(true),
  CHAT_MODERATION_RETRY_DELAY_MS: Joi.number()
    .integer()
    .min(1000)
    .default(10000),
  CHAT_MODERATION_MAX_RETRY: Joi.number().integer().min(1).default(3),
  CHAT_MODERATION_PREFETCH: Joi.number().integer().min(1).default(5),
  MODERATION_OUTBOX_POLL_MS: Joi.number().integer().min(100).default(1000),
  MODERATION_OUTBOX_BATCH_SIZE: Joi.number().integer().min(1).default(50),
  MODERATION_OUTBOX_LOCK_MS: Joi.number().integer().min(1000).default(30000),
  MODERATION_OUTBOX_MAX_ATTEMPTS: Joi.number().integer().min(1).default(10),
  MODERATION_OUTBOX_RETENTION_DAYS: Joi.number().integer().min(1).default(7),

  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug')
    .default('info'),
  LOG_DIR: Joi.string().default('logs'),
  LOG_CONSOLE_ENABLED: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .default(true),
  LOG_FILE_ENABLED: Joi.boolean().truthy('true').falsy('false').default(true),
  LOG_HEALTH_LOG_ENABLED: Joi.boolean()
    .truthy('true')
    .falsy('false')
    .default(false),
  LOG_DEPENDENCY_CHECK_INTERVAL_MS: Joi.number()
    .integer()
    .min(1000)
    .default(30000),
  LOG_MAX_FILE_SIZE_MB: Joi.number().min(1).default(20),
  LOG_RETENTION_DAYS: Joi.number().integer().min(1).default(30),
});
