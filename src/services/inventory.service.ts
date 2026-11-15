import { prisma, type TransactionClient } from "../lib/prisma.js";
import { ConflictError } from "../lib/errors.js";

// Inventory has two buckets per product:
//   availableQuantity — can still be bought
//   reservedQuantity  — held for orders that are not paid yet
//
// Every function below is a single atomic UPDATE with a guard in the WHERE
// clause, so concurrent requests can never push a bucket below zero.

/**
 * available → reserved. Called when an order is placed.
 * Fails with 409 if there isn't enough available stock.
 */
export async function reserveInventory(
  productId: number,
  quantity: number,
  tx: TransactionClient = prisma,
) {
  if (process.env.INVENTORY_STRATEGY === "naive") {
    return reserveInventoryNaive(productId, quantity, tx);
  }

  const updatedRows = await tx.$executeRaw`
    UPDATE "Inventory"
    SET
      "availableQuantity" = "availableQuantity" - ${quantity},
      "reservedQuantity" = "reservedQuantity" + ${quantity},
      "updatedAt" = NOW()
    WHERE
      "productId" = ${productId}
      AND "availableQuantity" >= ${quantity};
  `;

  if (updatedRows === 0) {
    throw new ConflictError("Out of stock");
  }

  return tx.inventory.findUnique({
    where: {
      productId,
    },
  });
}

/**
 * ⚠️ BENCHMARK BASELINE ONLY: deliberately WRONG. Enabled with
 * INVENTORY_STRATEGY=naive, never set in .env, compose or tests.
 *
 * This is the "obvious" implementation most people write first:
 *
 *   1. SELECT the inventory row
 *   2. check available >= quantity in JavaScript
 *   3. UPDATE ... SET available = <value computed in step 2>
 *
 * It looks correct and passes every single-user test. Under concurrency it
 * breaks: two transactions both read available = 1 in step 1 (Postgres's
 * default READ COMMITTED doesn't lock on a plain SELECT), both pass the check,
 * and both write available = 0. Two orders, one unit. The second write
 * silently overwrites the first (a "lost update"), so the counters even LOOK
 * healthy afterwards; only comparing them against the order rows reveals it.
 *
 * It exists so the load test can measure the bug the atomic version fixes,
 * on the same machine, with the same harness (see docs/BENCHMARKS.md).
 */
async function reserveInventoryNaive(productId: number, quantity: number, tx: TransactionClient) {
  const inventory = await tx.inventory.findUnique({ where: { productId } });
  if (!inventory || inventory.availableQuantity < quantity) {
    throw new ConflictError("Out of stock");
  }
  return tx.inventory.update({
    where: { productId },
    data: {
      availableQuantity: inventory.availableQuantity - quantity,
      reservedQuantity: inventory.reservedQuantity + quantity,
    },
  });
}

/**
 * reserved → available. Called when payment fails or the user cancels.
 * This is a *compensating action*: it undoes an earlier reservation.
 */
export async function releaseInventory(
  productId: number,
  quantity: number,
  tx: TransactionClient = prisma,
) {
  const updatedRows = await tx.$executeRaw`
    UPDATE "Inventory"
    SET
      "availableQuantity" = "availableQuantity" + ${quantity},
      "reservedQuantity" = "reservedQuantity" - ${quantity},
      "updatedAt" = NOW()
    WHERE
      "productId" = ${productId}
      AND "reservedQuantity" >= ${quantity};
  `;

  // If this happens, our bookkeeping is broken (we are releasing stock that
  // was never reserved). That is a bug, not a user error → plain Error → 500.
  if (updatedRows === 0) {
    throw new Error(
      `Inventory invariant violated: cannot release ${quantity} unit(s) of product ${productId}`,
    );
  }
}

/**
 * reserved → gone (sold). Called when payment succeeds.
 * The units leave the system for good; availableQuantity is untouched.
 */
export async function confirmReservation(
  productId: number,
  quantity: number,
  tx: TransactionClient = prisma,
) {
  const updatedRows = await tx.$executeRaw`
    UPDATE "Inventory"
    SET
      "reservedQuantity" = "reservedQuantity" - ${quantity},
      "updatedAt" = NOW()
    WHERE
      "productId" = ${productId}
      AND "reservedQuantity" >= ${quantity};
  `;

  if (updatedRows === 0) {
    throw new Error(
      `Inventory invariant violated: cannot confirm ${quantity} unit(s) of product ${productId}`,
    );
  }
}