import Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'production').default('development'),
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

  LOG_LEVEL: Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug').default('info'),
  LOG_DIR: Joi.string().default('logs'),
  LOG_CONSOLE_ENABLED: Joi.boolean().truthy('true').falsy('false').default(true),
  LOG_FILE_ENABLED: Joi.boolean().truthy('true').falsy('false').default(true),
  LOG_HEALTH_LOG_ENABLED: Joi.boolean().truthy('true').falsy('false').default(false),
  LOG_DEPENDENCY_CHECK_INTERVAL_MS: Joi.number().integer().min(1000).default(30000),
  LOG_MAX_FILE_SIZE_MB: Joi.number().min(1).default(20),
  LOG_RETENTION_DAYS: Joi.number().integer().min(1).default(30),
});
