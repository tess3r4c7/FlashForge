import type { FastifyInstance } from "fastify";
import {
  cancelOrder,
  createOrder,
  getOrderById,
} from "../services/order.service.js";
import { requestPayment } from "../services/payment.service.js";

// Errors thrown by services (NotFoundError, ConflictError, ...) are turned
// into HTTP responses by the global error handler in app.ts — so the route
// handlers below don't need try/catch blocks.

// --- Request types ---

interface CreateOrderBody {
  userId: number;
  items: {
    productId: number;
    quantity: number;
  }[];
}

interface OrderParams {
  id: number;
}

interface OrderActionBody {
  userId: number;
}

// --- Reusable schemas ---

const orderParamsSchema = {
  type: "object",
  required: ["id"],
  properties: {
    id: { type: "integer", minimum: 1 },
  },
} as const;

// Until we have real authentication, the caller says who they are in the
// body. The service checks that the order belongs to this user.
const orderActionBodySchema = {
  type: "object",
  required: ["userId"],
  properties: {
    userId: { type: "integer", minimum: 1 },
  },
  additionalProperties: false,
} as const;

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

      const order = await createOrder(request.body);
      return reply.status(201).send(order);
    },
  );

  // View an order with its items and payment
  app.get<{ Params: OrderParams }>(
    "/orders/:id",
    { schema: { params: orderParamsSchema } },
    async (request) => {
      return getOrderById(request.params.id);
    },
  );

  // Pay for an order — ASYNCHRONOUS since Phase 3
  //   202 → accepted: order is PAYMENT_PROCESSING, a worker will finish it.
  //         Poll GET /orders/:id to see CONFIRMED or CANCELLED.
  //   409 → order is not in a payable state (already paying, paid, cancelled)
  app.post<{ Params: OrderParams; Body: OrderActionBody }>(
    "/orders/:id/pay",
    {
      schema: {
        params: orderParamsSchema,
        body: orderActionBodySchema,
      },
    },
    async (request, reply) => {
      const order = await requestPayment(request.params.id, request.body.userId);

      // 202 Accepted = "I've taken your request and will process it, but it
      // isn't finished yet". The standard status for queued/background work.
      return reply.status(202).send(order);
    },
  );

  // Cancel an unpaid order (releases its reserved stock)
  app.post<{ Params: OrderParams; Body: OrderActionBody }>(
    "/orders/:id/cancel",
    {
      schema: {
        params: orderParamsSchema,
        body: orderActionBodySchema,
      },
    },
    async (request) => {
      return cancelOrder(request.params.id, request.body.userId);
    },
  );
}
