import process from 'node:process';

const REDIS_READY_TIMEOUT_MS = 10_000;

async function waitForRedisReady(redis) {
  if (redis.status === 'ready') return;

  await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      redis.off('ready', onReady);
      redis.off('end', onEnd);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onEnd = () => {
      cleanup();
      reject(new Error('Redis connection ended before readiness'));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Redis readiness timeout'));
    }, REDIS_READY_TIMEOUT_MS);

    redis.once('ready', onReady);
    redis.once('end', onEnd);
  });
}

async function main() {
  const { getRedis } = await import('/app/app/dist/lib/redis.js');
  await waitForRedisReady(getRedis());
  await import('/app/app/dist/server.js');
}

main().catch(() => {
  process.stderr.write('E2E API bootstrap failed before server start\n');
  process.exit(1);
});
