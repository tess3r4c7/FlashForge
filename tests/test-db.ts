import "dotenv/config";

/**
 * Tests use their OWN database ("flashforge_test"), never the dev one.
 *
 * Why (Phase 4): the outbox relay publishes EVERY unpublished row in the
 * OutboxEvent table. If tests and a dev worker shared one database, a dev
 * worker running in another terminal would grab test events (and vice versa).
 * A separate database also means tests can wipe tables freely.
 *
 * Same server, same user, different database name — derived from .env so
 * there is only one place to configure credentials.
 */
export function getTestDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;

  const devUrl = process.env.DATABASE_URL;
  if (!devUrl) throw new Error("DATABASE_URL is not set (check .env)");

  const url = new URL(devUrl);
  url.pathname = "/flashforge_test";
  return url.toString();
}

/**
 * Same idea for Redis (Phase 6): tests use logical database 1, dev uses 0.
 * global-setup.ts runs FLUSHDB on it, so it must never be the dev database.
 */
export function getTestRedisUrl(): string {
  if (process.env.TEST_REDIS_URL) return process.env.TEST_REDIS_URL;

  const url = new URL(process.env.REDIS_URL ?? "redis://localhost:6379");
  url.pathname = "/1";
  return url.toString();
}

