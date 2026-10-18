import { pino } from "pino";

// A logger for code that runs OUTSIDE an HTTP request:
// background workers, the RabbitMQ connection, startup/shutdown.
// (Inside route handlers, use `request.log` — Fastify's per-request logger.)
//
// Pino writes one JSON object per line, the same format Fastify uses,
// so API logs and worker logs look alike and can be searched together.
//
// LOG_LEVEL controls how chatty it is: "debug" | "info" | "warn" | "error".
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
});
