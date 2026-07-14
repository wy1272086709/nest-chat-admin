require('dotenv/config');

const autocannon = require('autocannon');
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const redis = new Redis({
  host: process.env.REDIS_HOST || '127.0.0.1',
  port: Number(process.env.REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD || undefined,
  db: Number(process.env.REDIS_DB || 0),
  connectTimeout: 5000,
  maxRetriesPerRequest: 1,
});

async function getActiveSession() {
  const users = await prisma.chatUser.findMany({
    where: { status: 'ACTIVE' },
    select: { id: true, email: true, username: true },
    take: 50,
  });

  if (users.length === 0) {
    throw new Error('No active ChatUser is available for the load test');
  }

  const keys = users.map((user) => `auth:current-jti:${user.id}`);
  const sessionIds = await redis.mget(keys);
  const index = sessionIds.findIndex(Boolean);

  if (index === -1) {
    throw new Error('No active login session is available for the load test');
  }

  return { user: users[index], jti: sessionIds[index] };
}

async function run() {
  const connections = Number(process.env.LOAD_TEST_CONNECTIONS || 20);
  const duration = Number(process.env.LOAD_TEST_DURATION || 15);
  const url =
    process.env.LOAD_TEST_URL || 'http://127.0.0.1:3000/api/chat/rooms';
  const { user, jti } = await getActiveSession();
  const token = jwt.sign(
    {
      sub: user.id,
      email: user.email,
      username: user.username,
      jti,
    },
    process.env.JWT_SECRET || 'secret-key',
    { expiresIn: '5m' },
  );

  const result = await autocannon({
    url,
    connections,
    duration,
    headers: {
      authorization: `Bearer ${token}`,
    },
  });

  const summary = {
    url,
    connections,
    durationSeconds: result.duration,
    requestsPerSecond: result.requests.average,
    totalRequests: result.requests.total,
    throughputBytesPerSecond: result.throughput.average,
    latencyMs: {
      average: result.latency.average,
      p50: result.latency.p50,
      p90: result.latency.p90,
      p99: result.latency.p99,
      max: result.latency.max,
    },
    errors: result.errors,
    timeouts: result.timeouts,
    non2xx: result.non2xx,
    statusCodeStats: result.statusCodeStats,
  };

  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

run()
  .catch((error) => {
    process.stderr.write(`Load test failed: ${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
  });
