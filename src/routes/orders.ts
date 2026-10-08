import type { FastifyInstance } from "fastify";
import { createOrder } from "../services/order.service.js";

// --- Request types ---

interface CreateOrderBody {
  userId: number;
  items: {
    productId: number;
    quantity: number;
  }[];
}

// --- Routes ---

export async function orderRoutes(app: FastifyInstance) {
  app.post<{ Body: CreateOrderBody }>(
    "/orders",
    {
      schema: {
        body: {
          type: "object",
          required: ["userId", "items"],
          properties: {
            userId: {
              type: "integer",
              minimum: 1,
            },
            items: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                required: ["productId", "quantity"],
                properties: {
                  productId: {
                    type: "integer",
                    minimum: 1,
                  },
                  quantity: {
                    type: "integer",
                    minimum: 1,
                  },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
      },
    },
    async (request, reply) => {
      // Check for duplicate productIds in the request.
      // If someone wants 3 of product X, they should send quantity: 3,
      // not two separate entries for the same product.
      const productIds = request.body.items.map((item) => item.productId);
      const uniqueIds = new Set(productIds);

      if (uniqueIds.size !== productIds.length) {
        return reply.status(400).send({
          error:
            "Duplicate productId in items. Use quantity to order multiple units.",
        });
      }

      try {
        const order = await createOrder(request.body);
        return reply.status(201).send(order);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Unknown error";

        // Determine the right HTTP status based on the error
        if (message === "User not found" || message.startsWith("Products not found")) {
          return reply.status(404).send({ error: message });
        }

        if (message === "Out of stock") {
          return reply.status(409).send({ error: message });
        }

        // Unexpected error — let Fastify's default handler deal with it
        throw error;
      }
    },
  );
}
