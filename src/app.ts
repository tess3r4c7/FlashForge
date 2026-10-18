import Fastify, { type FastifyError } from "fastify";
import {
  productRoutes,
  testReserveRoute,
} from "./routes/products.js";
import { orderRoutes } from "./routes/orders.js";
import { AppError } from "./lib/errors.js";
import { closePublisher } from "./messaging/publisher.js";

export function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });

  // When the app shuts down (server stop, or app.close() in tests),
  // close the RabbitMQ publisher connection too.
  app.addHook("onClose", async () => {
    await closePublisher();
  });

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

  app.get("/health", async () => {
    return {
      status: "ok",
    };
  });

  app.register(productRoutes);
  app.register(orderRoutes);
  app.register(testReserveRoute);

  return app;
}