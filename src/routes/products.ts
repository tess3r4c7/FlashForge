import type { FastifyInstance } from "fastify";
import {
  createProduct,
  getProductById,
  getProducts,
} from "../services/product.service.js";

interface CreateProductBody {
  name: string;
  description?: string;
  pricePaise: number;
  quantity: number;
}

export async function productRoutes(app: FastifyInstance) {
  // Served from the Redis cache when possible (see product.service.ts)
  app.get<{ Params: { id: number } }>(
    "/products/:id",
    {
      schema: {
        params: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "integer", minimum: 1 } },
        },
      },
    },
    async (request) => {
      return getProductById(request.params.id);
    },
  );
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
