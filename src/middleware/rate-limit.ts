import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import { hitRateLimit, type RateLimitOptions } from "../lib/rate-limiter.js";
import { rateLimitHitsTotal } from "../lib/metrics.js";

/** Defaults, overridable per deployment: 5 requests per 10s per user. */
export function rateLimitFromEnv(): RateLimitOptions {
  return {
    limit: Number(process.env.RATE_LIMIT_MAX ?? 5),
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 10_000),
  };
}

/**
 * Who is making the request?
 *
 * Until we have real authentication the caller sends `userId` in the body,
 * so that's what we limit on; requests without one fall back to the client IP.
 * (Yes, a client could lie about userId. Once auth exists, the key becomes the
 * authenticated user id - the limiter itself doesn't change.)
 */
function identify(request: FastifyRequest): string {
  const body = request.body as { userId?: unknown } | undefined;
  if (body && typeof body.userId === "number") return `user:${body.userId}`;
  return `ip:${request.ip}`;
}

/**
 * Route-level preHandler that enforces a per-user sliding-window limit.
 *
 * It's a preHandler (not onRequest) on purpose: by then Fastify has parsed
 * and VALIDATED the body, so we can trust `userId` is a number, and garbage
 * requests are rejected with 400 before they cost a Redis round-trip.
 *
 *   allowed  → sets RateLimit-* headers and lets the handler run
 *   rejected → 429 Too Many Requests + Retry-After (seconds), handler never runs
 *
 * @param bucket separates limits per action ("orders:create" vs "orders:pay")
 */
export function rateLimit(bucket: string, opts: RateLimitOptions): preHandlerAsyncHookHandler {
  return async function rateLimitHook(request: FastifyRequest, reply: FastifyReply) {
    const result = await hitRateLimit(`ratelimit:${bucket}:${identify(request)}`, opts);

    if (result.failedOpen) return; // Redis down: no headers, no limit

    // Standard-ish headers (IETF draft "RateLimit header fields for HTTP")
    reply.header("RateLimit-Limit", result.limit);
    reply.header("RateLimit-Remaining", result.remaining);

    if (!result.allowed) {
      const retryAfterSec = Math.ceil(result.retryAfterMs / 1000);
      rateLimitHitsTotal.inc({ bucket });
      request.log.info({ bucket, retryAfterSec }, "Rate limit exceeded");
      reply.header("Retry-After", retryAfterSec);
      return reply.status(429).send({
        error: `Too many requests. Try again in ${retryAfterSec}s.`,
      });
    }
  };
}

