// ─── Unit tests: idempotency request fingerprint ────────────────────────────
//
// hashRequest decides "is this retry the SAME request?". Too strict → honest
// retries get a 422. Too loose → a different order is silently replaced by
// the old response. Both are bugs a customer would notice.
//
// Writing these tests found a real bug: the hash used plain JSON.stringify,
// so a retry with the same fields in a different key order got a 422.

import { describe, expect, it } from "vitest";
import { hashRequest, idempotencyCacheKey } from "../../src/services/idempotency.service.js";

const order = { userId: 1, items: [{ productId: 7, quantity: 2 }] };

describe("hashRequest", () => {
  it("is a stable sha-256 hex digest", () => {
    expect(hashRequest(order)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashRequest(order)).toBe(hashRequest(structuredClone(order)));
  });

  it("ignores object key order (same request, serialised differently)", () => {
    const reordered = { items: [{ quantity: 2, productId: 7 }], userId: 1 };
    expect(hashRequest(reordered)).toBe(hashRequest(order));
  });

  it("treats a missing key and an undefined key as the same (JSON drops undefined)", () => {
    expect(hashRequest({ ...order, note: undefined })).toBe(hashRequest(order));
  });

  it("changes when any value changes", () => {
    expect(hashRequest({ ...order, userId: 2 })).not.toBe(hashRequest(order));
    expect(hashRequest({ userId: 1, items: [{ productId: 7, quantity: 3 }] })).not.toBe(hashRequest(order));
    expect(hashRequest({ userId: 1, items: [{ productId: 8, quantity: 2 }] })).not.toBe(hashRequest(order));
  });

  it("keeps array order significant", () => {
    const a = { userId: 1, items: [{ productId: 1, quantity: 1 }, { productId: 2, quantity: 1 }] };
    const b = { userId: 1, items: [{ productId: 2, quantity: 1 }, { productId: 1, quantity: 1 }] };
    expect(hashRequest(a)).not.toBe(hashRequest(b));
  });

  it("distinguishes types that stringify similarly", () => {
    expect(hashRequest({ q: 1 })).not.toBe(hashRequest({ q: "1" }));
    expect(hashRequest({ q: null })).not.toBe(hashRequest({}));
  });
});

describe("idempotencyCacheKey", () => {
  it("scopes keys per user so two users can pick the same key string", () => {
    expect(idempotencyCacheKey(1, "abc")).not.toBe(idempotencyCacheKey(2, "abc"));
    expect(idempotencyCacheKey(1, "abc")).toBe("idem:1:abc");
  });
});

