import { prisma, type TransactionClient } from "../lib/prisma.js";

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
    throw new Error("Out of stock");
  }

  return tx.inventory.findUnique({
    where: {
      productId,
    },
  });
}