import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Use the "tests/" directory for test files
    include: ["tests/**/*.test.ts"],

    // Longer timeout for integration tests that talk to the database
    testTimeout: 30_000,

    // Don't run tests in parallel by default —
    // our concurrency tests share a real database
    fileParallelism: false,

    env: {
      // Tests get their own RabbitMQ exchange + queues ("test.flashforge.events"),
      // so a dev worker running in another terminal can't steal test messages.
      RABBITMQ_PREFIX: "test.",
      // Hide the per-request info logs; warnings and errors still show.
      LOG_LEVEL: "warn",
    },
  },
});
