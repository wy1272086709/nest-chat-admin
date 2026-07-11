export default () => ({
    app: {
        name: process.env.APP_NAME ?? 'nextjs-server',
        env: process.env.NODE_ENV ?? 'development',
        port: Number(process.env.APP_PORT ?? 3000),
        apiPrefix: process.env.APP_API_PREFIX ?? 'api',
    },
    database: {
        host: process.env.DB_HOST ?? '127.0.0.1',
        port: Number(process.env.DB_PORT ?? 5432),
        username: process.env.DB_USERNAME ?? 'root',
        password: process.env.DB_PASSWORD ?? '',
        name: process.env.DB_NAME ?? 'public',
        synchronize: process.env.DB_SYNC === 'true',
        logging: process.env.DB_LOGGING === 'true',
    },
    jwt: {
        secret: process.env.JWT_SECRET ?? 'secret-key',
        expiresIn: process.env.JWT_EXPIRES_IN ?? '7d',
    },
    redis: {
        host: process.env.REDIS_HOST ?? '127.0.0.1',
        port: Number(process.env.REDIS_PORT ?? 6379),
        password: process.env.REDIS_PASSWORD || undefined,
        db: Number(process.env.REDIS_DB ?? 0),
    },
    log: {
        level: process.env.LOG_LEVEL ?? 'info',
        dir: process.env.LOG_DIR ?? 'logs',
        consoleEnabled: process.env.LOG_CONSOLE_ENABLED !== 'false',
        fileEnabled: process.env.LOG_FILE_ENABLED !== 'false',
        healthLogEnabled: process.env.LOG_HEALTH_LOG_ENABLED === 'true',
        dependencyCheckIntervalMs: Number(process.env.LOG_DEPENDENCY_CHECK_INTERVAL_MS ?? 30000),
        maxFileSizeMb: Number(process.env.LOG_MAX_FILE_SIZE_MB ?? 20),
        retentionDays: Number(process.env.LOG_RETENTION_DAYS ?? 30),
    },
    email: {
        host: process.env.EMAIL_HOST ?? 'smtp.qq.com',
        port: Number(process.env.EMAIL_PORT ?? 587),
        secure: process.env.EMAIL_SECURE === 'true',
        user: process.env.EMAIL_USER ?? '1272086709@qq.com',
        pass: process.env.EMAIL_PASSWORD ?? 'pvwgbflzsactfibg',
    },
});
