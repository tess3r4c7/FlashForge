import { prisma } from "../lib/prisma.js";

export function getProducts() {
  return prisma.product.findMany({
    orderBy: {
      id: "asc",
    },
  });
}

interface CreateProductInput {
  name: string;
  description?: string;
  pricePaise: number;
  quantity: number;
}

export function createProduct(input: CreateProductInput) {
  return prisma.$transaction(async (tx) => {
    const product = await tx.product.create({
      data: {
        name: input.name,
        description: input.description ?? null,
        pricePaise: input.pricePaise,
      },
    });

    const inventory = await tx.inventory.create({
      data: {
        productId: product.id,
        availableQuantity: input.quantity,
      },
    });

    return {
      ...product,
      inventory,
    };
  });
}