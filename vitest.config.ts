import { defineConfig } from "vitest/config";
import { getTestDatabaseUrl, getTestRedisUrl } from "./tests/test-db.js";

// Two test projects (Phase 9):
//   unit         tests/unit/**   pure logic, no Docker needed, runs in ~1s
//   integration  tests/*.test.ts real Postgres + RabbitMQ + Redis
//
//   npm run test:unit          # fast feedback while coding
//   npm run test:integration   # needs `docker compose up -d`
//   npm run test:run           # both
export default defineConfig({
  test: {
    // Longer timeout for integration tests that talk to the database
    testTimeout: 30_000,

    // Don't run tests in parallel by default —
    // our concurrency tests share a real database
    fileParallelism: false,

    // `npm run test:coverage` (Phase 10). v8 coverage uses the engine's own
    // instrumentation: no source transform, so tests behave exactly as usual.
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/generated/**", // Prisma's generated client, not our code
        "src/server.ts", // process entry points: started as real processes
        "src/worker.ts", //   in load tests, not imported by Vitest
        "src/scripts/**", // CLIs (dlq, seed)
      ],
      reporter: ["text-summary", "html", "lcov"],
      reportsDirectory: "coverage",
    },

    env: {
      // Tests use their own database (flashforge_test), see tests/test-db.ts.
      // dotenv never overrides variables that are already set, so this wins
      // over the DATABASE_URL in .env.
      DATABASE_URL: getTestDatabaseUrl(),
      // Tests get their own RabbitMQ exchange + queues ("test.flashforge.events"),
      // so a dev worker running in another terminal can't steal test messages.
      RABBITMQ_PREFIX: "test.",
      // Hide the per-request info logs; warnings and errors still show.
      LOG_LEVEL: "warn",
      // Poll the outbox quickly so async tests don't wait around.
      OUTBOX_POLL_INTERVAL_MS: "50",
      // Short back-off so retry/DLQ tests finish quickly (prod: 1s, 5s, 30s).
      RETRY_DELAYS_MS: "100,200,400",
      PAYMENT_GATEWAY_TRANSIENT_FAILURES: "0",
      // Redis logical database 1 (dev uses 0), flushed in global-setup.ts.
      REDIS_URL: getTestRedisUrl(),
      // Effectively no rate limit, so the concurrency tests (dozens of orders
      // from user 1 at once) aren't throttled. phase6.test.ts builds apps
      // with explicit small limits to test the limiter itself.
      RATE_LIMIT_MAX: "1000000",
    },

    projects: [
      {
        // `extends: true` = inherit everything above (env, timeout).
        extends: true,
        test: {
          name: "unit",
          include: ["tests/unit/**/*.test.ts"],
          // No globalSetup: unit tests must not need Docker. Importing a
          // module that creates a Prisma/Redis client is fine (both connect
          // lazily); actually querying one would be a bug in the test.
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["tests/*.test.ts"],
          // Creates + migrates + wipes the test database once before all tests.
          globalSetup: ["./tests/global-setup.ts"],
        },
      },
    ],
  },
});
