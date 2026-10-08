import type { FastifyInstance } from "fastify";
import {
  createProduct,
  getProducts,
} from "../services/product.service.js";

import { reserveInventory } from "../services/inventory.service.js";

interface CreateProductBody {
  name: string;
  description?: string;
  pricePaise: number;
  quantity: number;
}

export async function productRoutes(app: FastifyInstance) {
  app.get("/products", async () => {
    return getProducts();
  });

  app.post<{ Body: CreateProductBody }>(
    "/products",
    {
      schema: {
        body: {
          type: "object",
          required: ["name", "pricePaise", "quantity"],
          properties: {
            name: {
              type: "string",
              minLength: 1,
            },
            description: {
              type: "string",
            },
            pricePaise: {
              type: "integer",
              minimum: 0,
            },
            quantity: {
              type: "integer",
              minimum: 0,
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      const product = await createProduct(request.body);

      return reply.code(201).send(product);
    },
  );
}

export async function testReserveRoute(app: FastifyInstance) {
  app.post("/test/reserve", async (request, reply) => {
    const body = request.body as {
      productId: number;
      quantity: number;
    };

    try {
      const inventory = await reserveInventory(
        body.productId,
        body.quantity,
      );

      return reply.send(inventory);
    } catch (error) {
      return reply.status(400).send({
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
}