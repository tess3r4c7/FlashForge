import { prisma } from "../lib/prisma.js";
import { reserveInventory } from "./inventory.service.js";

// --- Types ---

interface OrderItemInput {
  productId: number;
  quantity: number;
}

interface CreateOrderInput {
  userId: number;
  items: OrderItemInput[];
}

// --- Service ---

export async function createOrder(input: CreateOrderInput) {
  // Everything below runs inside a single database transaction.
  // If anything throws, ALL changes are rolled back automatically —
  // no partial reservations, no orphaned orders.
  return prisma.$transaction(async (tx) => {
    // Step 1: Validate user exists
    const user = await tx.user.findUnique({
      where: { id: input.userId },
    });

    if (!user) {
      throw new Error("User not found");
    }

    // Step 2: Fetch all requested products in one query
    // We need the current price to snapshot it into the order.
    const productIds = input.items.map((item) => item.productId);

    const products = await tx.product.findMany({
      where: { id: { in: productIds } },
    });

    // Make sure every requested product actually exists
    if (products.length !== productIds.length) {
      const foundIds = new Set(products.map((p) => p.id));
      const missingIds = productIds.filter((id) => !foundIds.has(id));
      throw new Error(`Products not found: ${missingIds.join(", ")}`);
    }

    // Step 3: Reserve inventory for EACH item
    // This is where concurrency protection happens.
    // Each reserveInventory call does: UPDATE ... WHERE available >= quantity
    // If ANY item is out of stock, it throws → transaction rolls back →
    // all previous reservations in this transaction disappear.
    for (const item of input.items) {
      await reserveInventory(item.productId, item.quantity, tx);
    }

    // Step 4: Build order items with snapshotted prices
    // Why snapshot? If the product price changes tomorrow, this order
    // should still show what the customer actually paid.
    const productMap = new Map(products.map((p) => [p.id, p]));

    let totalAmountPaise = 0;

    const orderItemsData = input.items.map((item) => {
      const product = productMap.get(item.productId)!;
      const unitPricePaise = product.pricePaise;
      const itemTotal = unitPricePaise * item.quantity;
      totalAmountPaise += itemTotal;

      return {
        productId: item.productId,
        quantity: item.quantity,
        unitPricePaise,
      };
    });

    // Step 5: Create the order + order items in one Prisma call
    // Status is INVENTORY_RESERVED because by the time this line runs,
    // all inventory has been successfully reserved above.
    const order = await tx.order.create({
      data: {
        userId: input.userId,
        status: "INVENTORY_RESERVED",
        totalAmountPaise,
        items: {
          create: orderItemsData,
        },
      },
      include: {
        items: true,
      },
    });

    return order;
  });
}
