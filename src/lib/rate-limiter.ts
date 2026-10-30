import { randomUUID } from "node:crypto";
import { getRedis } from "./redis.js";
import { logger } from "./logger.js";

// ─── Sliding-window rate limiter (Redis) ────────────────────────────────────
//
// Question: "has this user made fewer than LIMIT requests in the last WINDOW ms?"
//
// Data: one Redis SORTED SET per user. Each member = one request, its score =
// the time it was made (ms).
//
//   ratelimit:orders:user:1 = { req-a @ 1000, req-b @ 1400, req-c @ 1900 }
//
// On every request, ATOMICALLY (one Lua script, see below):
//   1. ZREMRANGEBYSCORE  drop entries older than now - WINDOW
//   2. ZCARD             count what's left
//   3. count < LIMIT  →  ZADD this request, allow
//      otherwise      →  reject, and tell the client when the oldest entry
//                        leaves the window (= Retry-After)
//   4. PEXPIRE           the whole key disappears if the user goes quiet
//
// Why a Lua script? Redis runs a script as ONE indivisible step: no other
// command can run between the ZCARD and the ZADD. Done as separate commands
// from Node, two concurrent requests could both read count = LIMIT-1 and both
// be allowed - the same check-then-act race we fixed for inventory in Phase 1,
// just in Redis instead of Postgres.
//
// Why redis.call('TIME') instead of Date.now() from Node? With several API
// instances, their clocks drift. Using Redis's clock means every instance
// agrees on what "now" is.
//
// Why sliding window instead of the simpler FIXED window (INCR + EXPIRE per
// "minute bucket")? A fixed window lets a client send LIMIT requests at
// 12:00:59.9 and LIMIT more at 12:01:00.1 - double the limit in 0.2s, exactly
// the burst a flash sale produces. The sliding log has no boundaries.
// Cost: memory is O(LIMIT) per active user, fine for small per-user limits.
// (Token bucket / GCRA are O(1) alternatives if limits were in the thousands.)
const SLIDING_WINDOW_SCRIPT = `
local key    = KEYS[1]
local window = tonumber(ARGV[1])
local limit  = tonumber(ARGV[2])
local member = ARGV[3]

local t   = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return {1, limit - count - 1, 0}
end

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retryAfter = tonumber(oldest[2]) + window - now
if retryAfter < 1 then retryAfter = 1 end
return {0, 0, retryAfter}
`;

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** ms until the next request would be allowed (0 when allowed) */
  retryAfterMs: number;
  /** true = Redis was unavailable and we let the request through */
  failedOpen: boolean;
}

export interface RateLimitOptions {
  /** Max requests allowed per window */
  limit: number;
  /** Window length in ms */
  windowMs: number;
}

/**
 * Records one request for `key` and says whether it is allowed.
 * Never throws: if Redis is unavailable the request is ALLOWED (fail open).
 */
export async function hitRateLimit(key: string, opts: RateLimitOptions): Promise<RateLimitResult> {
  try {
    const [allowed, remaining, retryAfterMs] = (await getRedis().eval(
      SLIDING_WINDOW_SCRIPT,
      1,
      key,
      opts.windowMs,
      opts.limit,
      randomUUID(), // unique member: two requests in the same ms must not collapse into one
    )) as [number, number, number];

    return {
      allowed: allowed === 1,
      limit: opts.limit,
      remaining,
      retryAfterMs,
      failedOpen: false,
    };
  } catch (err) {
    // Fail open: better to let a burst through than to reject every order
    // because a non-critical helper is down. Inventory correctness is still
    // guaranteed by Postgres (atomic reservations), so this can't oversell.
    logger.warn({ err: (err as Error).message, key }, "Rate limiter unavailable - allowing request");
    return {
      allowed: true,
      limit: opts.limit,
      remaining: opts.limit,
      retryAfterMs: 0,
      failedOpen: true,
    };
  }
}

