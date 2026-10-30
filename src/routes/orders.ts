import type { FastifyInstance } from "fastify";
import {
  cancelOrder,
  createOrder,
  createOrderIdempotent,
  getOrderById,
} from "../services/order.service.js";
import { requestPayment } from "../services/payment.service.js";
import { rateLimit } from "../middleware/rate-limit.js";
import type { RateLimitOptions } from "../lib/rate-limiter.js";

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

interface CreateOrderHeaders {
  "idempotency-key"?: string;
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

export interface OrderRoutesOptions {
  /** Per-user limit for creating and paying orders; `false` disables it. */
  rateLimit: RateLimitOptions | false;
}

export async function orderRoutes(app: FastifyInstance, opts: OrderRoutesOptions) {
  // Flash-sale protection (Phase 6): the two WRITE endpoints are limited per
  // user, each with its own bucket. Reads (GET /orders/:id) are not limited:
  // clients poll it while a payment is processing.
  const createLimit = opts.rateLimit ? [rateLimit("orders:create", opts.rateLimit)] : [];
  const payLimit = opts.rateLimit ? [rateLimit("orders:pay", opts.rateLimit)] : [];

  // Optional header: Idempotency-Key: <client-generated unique string, e.g. a UUID>
  //   Same key again (same user, same body) → the ORIGINAL 201 response is
  //     returned, with header "Idempotent-Replayed: true". No second order.
  //   Same key, different body → 422 (client bug).
  //   No header → every request creates a new order (old behaviour).
  app.post<{ Body: CreateOrderBody; Headers: CreateOrderHeaders }>(
    "/orders",
    {
      preHandler: createLimit,
      schema: {
        headers: {
          type: "object",
          properties: {
            "idempotency-key": { type: "string", minLength: 1, maxLength: 255 },
          },
        },
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

      const idempotencyKey = request.headers["idempotency-key"];
      if (idempotencyKey === undefined) {
        const order = await createOrder(request.body);
        return reply.status(201).send(order);
      }

      const result = await createOrderIdempotent(request.body, idempotencyKey);
      if (result.replayed) reply.header("Idempotent-Replayed", "true");
      return reply.status(result.statusCode).send(result.body);
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
      preHandler: payLimit,
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
