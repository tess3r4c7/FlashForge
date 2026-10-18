// Must be the FIRST import: ES modules run their top-level code in import
// order, and several modules read process.env as soon as they load.
import "dotenv/config";
import { buildApp } from "./app.js";
import { prisma } from "./lib/prisma.js";

const app = buildApp();

const start = async () => {
  try {
    await app.listen({
      port: 3000,
      host: "0.0.0.0",
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

// Graceful shutdown: finish in-flight requests, close RabbitMQ (via the
// onClose hook in app.ts) and the database pool, then exit.
let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "Shutting down API...");
  await app.close();
  await prisma.$disconnect();
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

start();