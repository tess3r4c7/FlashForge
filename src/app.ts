import Fastify from "fastify";
import {
  productRoutes,
  testReserveRoute,
} from "./routes/products.js";
import { orderRoutes } from "./routes/orders.js";

export function buildApp() {
  const app = Fastify({
    logger: true,
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