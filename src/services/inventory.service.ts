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