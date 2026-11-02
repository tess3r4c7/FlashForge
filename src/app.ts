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
import { createContext, runWithContext } from "./lib/context.js";
import {
  registry,
  httpRequestsTotal,
  httpRequestDuration,
} from "./lib/metrics.js";
import { prisma } from "./lib/prisma.js";
import { connectRabbitMQ } from "./messaging/rabbitmq.js";

export interface BuildAppOptions {
  /** Per-user limit on order writes. Defaults to RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS; `false` disables. */
  rateLimit?: RateLimitOptions | false;
  /** Skip /metrics endpoint and request-level metrics collection (for tests). */
  disableMetrics?: boolean;
}

export function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
    // Use our own request ID format (UUID) instead of Fastify's default
    // counter. UUIDs are globally unique, so they work across load-balanced
    // instances.
    genReqId: () => createContext().requestId,
  });

  // ─── Correlation IDs (Phase 7) ──────────────────────────────────────
  // Every inbound request runs inside an AsyncLocalStorage context.
  // Any code downstream (services, the outbox writer) can call
  // getRequestContext() to get the IDs without them being passed as args.
  app.addHook("onRequest", (request, _reply, done) => {
    // If the client sends X-Correlation-Id, use it; otherwise the request
    // ID doubles as the correlation ID (= the action starts here).
    const correlationId =
      (request.headers["x-correlation-id"] as string | undefined) ??
      (request.id as string);

    const ctx = createContext(correlationId);
    // Override the request ID so Fastify's built-in logger uses the same one.
    (request as { id: string }).id = ctx.requestId;

    // Bind the whole request lifecycle to this context.
    runWithContext(ctx, () => done());
  });

  // Attach correlationId to every response for easy client-side debugging.
  app.addHook("onSend", (request, reply, _payload, done) => {
    const cid =
      (request.headers["x-correlation-id"] as string | undefined) ??
      (request.id as string);
    reply.header("X-Correlation-Id", cid);
    done();
  });

  // ─── Metrics (Phase 7) ──────────────────────────────────────────────
  if (!options.disableMetrics) {
    app.addHook("onResponse", (request, reply, done) => {
      // Fastify adds `request.routeOptions.url` which is the registered
      // route pattern (e.g. "/orders/:id") — safe to use as a label because
      // it's bounded (one per route, not one per order ID).
      const route = request.routeOptions?.url ?? request.url;
      const labels = {
        method: request.method,
        route,
        status_code: String(reply.statusCode),
      };
      httpRequestsTotal.inc(labels);
      // Fastify measures elapsed time in ms; Prometheus convention is seconds.
      httpRequestDuration.observe(labels, reply.elapsedTime / 1000);
      done();
    });
  }

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

  // ─── Health check (Phase 7: expanded) ─────────────────────────────────
  // Checks all three infrastructure dependencies. A load balancer can use
  // this to take an instance out of rotation when a critical dependency is
  // unreachable. `status: "degraded"` means the API still works but some
  // features are reduced.
  app.get("/health", async () => {
    const checks: Record<string, string> = {};

    // Postgres
    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.postgres = "up";
    } catch {
      checks.postgres = "down";
    }

    // RabbitMQ — try a lightweight TCP connection. We don't keep it.
    try {
      const conn = await connectRabbitMQ("healthcheck");
      await conn.close();
      checks.rabbitmq = "up";
    } catch {
      checks.rabbitmq = "down";
    }

    // Redis
    checks.redis = isRedisReady() ? "up" : "down";

    const allUp = Object.values(checks).every((v) => v === "up");
    return {
      status: allUp ? "ok" : checks.postgres === "down" ? "error" : "degraded",
      ...checks,
    };
  });

  // ─── Prometheus metrics endpoint (Phase 7) ───────────────────────────
  if (!options.disableMetrics) {
    app.get("/metrics", async (_request, reply) => {
      reply.header("Content-Type", registry.contentType);
      return registry.metrics();
    });
  }

  app.register(productRoutes);
  app.register(orderRoutes, { rateLimit: options.rateLimit ?? rateLimitFromEnv() });
  app.register(testReserveRoute);

  return app;
}
