import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  buildTestApp,
  createTestProduct,
  getInventory,
  cleanupTestProducts,
} from "./helpers.js";
import type { FastifyInstance } from "fastify";

// ─── Test state ─────────────────────────────────────────────
let app: FastifyInstance;
const testProductIds: number[] = [];

beforeAll(async () => {
  app = buildTestApp();
  await app.ready();
});

afterAll(async () => {
  await cleanupTestProducts(testProductIds);
  await app.close();
});

// ─── Helper: send an order request via Fastify inject ────────
async function placeOrder(
  userId: number,
  items: { productId: number; quantity: number }[],
) {
  const response = await app.inject({
    method: "POST",
    url: "/orders",
    payload: { userId, items },
  });

  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body),
  };
}

// ─── Tests ──────────────────────────────────────────────────

describe("POST /orders — concurrency", () => {
  it("10 units, 20 concurrent requests → exactly 10 succeed, 10 fail", async () => {
    // Arrange: create a product with exactly 10 units
    const STOCK = 10;
    const CONCURRENT_REQUESTS = 20;

    const productId = await createTestProduct(STOCK);
    testProductIds.push(productId);

    // Act: fire 20 requests AT THE SAME TIME
    // Promise.all starts all requests concurrently — they all hit the
    // database roughly simultaneously, just like a real flash sale.
    const results = await Promise.all(
      Array.from({ length: CONCURRENT_REQUESTS }, () =>
        placeOrder(1, [{ productId, quantity: 1 }]),
      ),
    );

    // Assert: count successes and failures
    const successes = results.filter((r) => r.statusCode === 201);
    const failures = results.filter((r) => r.statusCode === 409);

    // Exactly 10 should succeed (we had 10 units)
    expect(successes).toHaveLength(STOCK);

    // Exactly 10 should fail with "Out of stock"
    expect(failures).toHaveLength(CONCURRENT_REQUESTS - STOCK);

    // Every failure should have the right error message
    for (const failure of failures) {
      expect(failure.body.error).toBe("Out of stock");
    }

    // The database should show the correct final state
    const inventory = await getInventory(productId);
    expect(inventory!.availableQuantity).toBe(0);
    expect(inventory!.reservedQuantity).toBe(STOCK);
  });

  it("1 unit, 50 concurrent requests → exactly 1 succeeds", async () => {
    // This is the classic flash-sale scenario:
    // one item, many buyers, only one winner.
    const productId = await createTestProduct(1);
    testProductIds.push(productId);

    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        placeOrder(1, [{ productId, quantity: 1 }]),
      ),
    );

    const successes = results.filter((r) => r.statusCode === 201);
    const failures = results.filter((r) => r.statusCode === 409);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(49);

    const inventory = await getInventory(productId);
    expect(inventory!.availableQuantity).toBe(0);
    expect(inventory!.reservedQuantity).toBe(1);
  });

  it("multi-item order: rollback when second item is out of stock", async () => {
    // Product A: plenty of stock
    // Product B: zero stock
    // An order for [A, B] should fail, and A's inventory should be unchanged.
    const productA = await createTestProduct(100);
    const productB = await createTestProduct(0);
    testProductIds.push(productA, productB);

    const inventoryBefore = await getInventory(productA);

    const result = await placeOrder(1, [
      { productId: productA, quantity: 5 },
      { productId: productB, quantity: 1 },
    ]);

    expect(result.statusCode).toBe(409);

    // Product A's inventory must be UNCHANGED — the rollback worked
    const inventoryAfter = await getInventory(productA);
    expect(inventoryAfter!.availableQuantity).toBe(
      inventoryBefore!.availableQuantity,
    );
    expect(inventoryAfter!.reservedQuantity).toBe(
      inventoryBefore!.reservedQuantity,
    );
  });

  it("concurrent multi-item orders competing for shared inventory", async () => {
    // Product A: 5 units, Product B: 3 units
    // Each order requests 1 of A + 1 of B
    // Maximum possible successful orders = 3 (limited by Product B)
    // We send 10 concurrent requests
    const productA = await createTestProduct(5);
    const productB = await createTestProduct(3);
    testProductIds.push(productA, productB);

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        placeOrder(1, [
          { productId: productA, quantity: 1 },
          { productId: productB, quantity: 1 },
        ]),
      ),
    );

    const successes = results.filter((r) => r.statusCode === 201);
    const failures = results.filter((r) => r.statusCode === 409);

    // At most 3 can succeed (Product B is the bottleneck)
    expect(successes.length).toBeLessThanOrEqual(3);
    expect(successes.length).toBeGreaterThanOrEqual(1);

    // Verify inventory consistency:
    // For each product: available + reserved should equal the original stock
    const invA = await getInventory(productA);
    const invB = await getInventory(productB);

    expect(invA!.availableQuantity + invA!.reservedQuantity).toBe(5);
    expect(invB!.availableQuantity + invB!.reservedQuantity).toBe(3);

    // Both products should have the same number reserved
    // (each successful order reserves 1 of each)
    expect(invA!.reservedQuantity).toBe(invB!.reservedQuantity);
    expect(invA!.reservedQuantity).toBe(successes.length);
  });
});

describe("POST /orders — validation", () => {
  it("rejects non-existent user", async () => {
    const productId = await createTestProduct(10);
    testProductIds.push(productId);

    const result = await placeOrder(99999, [{ productId, quantity: 1 }]);

    expect(result.statusCode).toBe(404);
    expect(result.body.error).toBe("User not found");
  });

  it("rejects non-existent product", async () => {
    const result = await placeOrder(1, [{ productId: 99999, quantity: 1 }]);

    expect(result.statusCode).toBe(404);
    expect(result.body.error).toContain("Products not found");
  });

  it("rejects empty items array", async () => {
    const result = await placeOrder(1, []);

    expect(result.statusCode).toBe(400);
  });

  it("rejects duplicate productIds", async () => {
    const productId = await createTestProduct(10);
    testProductIds.push(productId);

    const result = await placeOrder(1, [
      { productId, quantity: 1 },
      { productId, quantity: 1 },
    ]);

    expect(result.statusCode).toBe(400);
    expect(result.body.error).toContain("Duplicate productId");
  });
});
