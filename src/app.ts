import Fastify, { type FastifyError } from "fastify";
import {
  productRoutes,
  testReserveRoute,
} from "./routes/products.js";
import { orderRoutes } from "./routes/orders.js";
import { AppError } from "./lib/errors.js";
import { closeRedis, connectRedis, isRedisReady } from "./lib/redis.js";
import type { RateLimitOptions } from "./lib/rate-limiter.js";
import { rateLimitFromEnv } from "./middleware/rate-limit.js";

export interface BuildAppOptions {
  /** Per-user limit on order writes. Defaults to RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS; `false` disables. */
  rateLimit?: RateLimitOptions | false;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });

  // Note (Phase 4): the API no longer talks to RabbitMQ at all. Services
  // write events to the OutboxEvent table inside their DB transactions, and
  // the outbox relay in the worker process publishes them.

  // One place that turns errors into HTTP responses.
  //   AppError (thrown by our services)  → its own status + message
  //   Fastify errors (bad JSON, schema)  → their status (usually 400)
  //   Anything else (bugs, DB down)      → 500, details only in the logs
  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: error.message });
    }

    const statusCode = error.statusCode ?? 500;

    if (statusCode >= 500) {
      request.log.error(error);
      // Never leak internal details (SQL, stack traces) to clients
      return reply.status(500).send({ error: "Internal Server Error" });
    }

    return reply.status(statusCode).send({ error: error.message });
  });

  // Redis (Phase 6) powers rate limiting and caching. It's optional at
  // runtime: connectRedis() never throws, and every Redis feature fails open.
  app.addHook("onReady", async () => {
    await connectRedis();
  });
  app.addHook("onClose", async () => {
    await closeRedis();
  });

  app.get("/health", async () => {
    return {
      status: "ok",
      // "down" = degraded, not broken: no rate limiting / caching until it returns.
      redis: isRedisReady() ? "up" : "down",
    };
  });

  app.register(productRoutes);
  app.register(orderRoutes, { rateLimit: options.rateLimit ?? rateLimitFromEnv() });
  app.register(testReserveRoute);

  return app;
}