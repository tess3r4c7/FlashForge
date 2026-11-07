// ─── Unit tests: retry schedule + typed errors ──────────────────────────────
//
// Small pieces, but each one is load-bearing:
//   parseDelays     a typo in RETRY_DELAYS_MS must not silently disable retries
//   queue names     the worker and the DLQ replay tool must agree on them
//   AppError family the global error handler maps these to HTTP status codes

import { describe, expect, it } from "vitest";
import { deadLetterQueueName, parseDelays, retryQueueName } from "../../src/messaging/rabbitmq.js";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnprocessableEntityError,
} from "../../src/lib/errors.js";

describe("parseDelays (RETRY_DELAYS_MS)", () => {
  it("defaults to 1s, 5s, 30s", () => {
    expect(parseDelays(undefined)).toEqual([1000, 5000, 30000]);
    expect(parseDelays("")).toEqual([1000, 5000, 30000]);
  });

  it("parses a comma list, tolerating spaces", () => {
    expect(parseDelays("100, 200 ,400")).toEqual([100, 200, 400]);
  });

  it("drops junk, zero and negative entries", () => {
    expect(parseDelays("100,abc,0,-5,300")).toEqual([100, 300]);
  });

  it("falls back to the default if nothing valid is left (retries never silently disappear)", () => {
    expect(parseDelays("abc,0")).toEqual([1000, 5000, 30000]);
  });
});

describe("queue naming", () => {
  it("one retry queue per delay, plus a DLQ", () => {
    expect(retryQueueName("payments.process", 5000)).toBe("payments.process.retry.5000ms");
    expect(deadLetterQueueName("payments.process")).toBe("payments.process.dlq");
  });
});

describe("AppError family", () => {
  it.each([
    [NotFoundError, 404],
    [ForbiddenError, 403],
    [ConflictError, 409],
    [UnprocessableEntityError, 422],
  ] as const)("%o carries status %i", (ErrorClass, status) => {
    const err = new ErrorClass("boom");
    expect(err).toBeInstanceOf(AppError);
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(status);
    expect(err.message).toBe("boom");
    expect(err.name).toBe(ErrorClass.name); // shows up in logs as e.g. "ConflictError"
  });
});

