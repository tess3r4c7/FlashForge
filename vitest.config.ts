import { defineConfig } from "vitest/config";
import { getTestDatabaseUrl } from "./tests/test-db.js";

export default defineConfig({
  test: {
    // Use the "tests/" directory for test files
    include: ["tests/**/*.test.ts"],

    // Longer timeout for integration tests that talk to the database
    testTimeout: 30_000,

    // Don't run tests in parallel by default —
    // our concurrency tests share a real database
    fileParallelism: false,

    // Creates + migrates + wipes the test database once before all tests.
    globalSetup: ["./tests/global-setup.ts"],

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
    },
  },
});
