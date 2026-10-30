import { prisma } from "../lib/prisma.js";
import { cached, invalidate } from "../lib/cache.js";
import { NotFoundError } from "../lib/errors.js";

// ─── Product cache (Phase 6) ────────────────────────────────────────────────
// During a flash sale thousands of clients refresh the product page. Product
// rows (name, description, price) almost never change, so we serve them from
// Redis and only hit Postgres once per TTL.
//
// Deliberately NOT cached: inventory / stock. It changes on every order, and
// a stale "5 left" is worse than a slow one. Orders always read stock from
// Postgres inside their transaction, so caching can never cause an oversell.

const PRODUCT_CACHE_TTL_SECONDS = Number(process.env.PRODUCT_CACHE_TTL_SECONDS ?? 30);

export const productCacheKeys = {
  all: "cache:products:all",
  one: (id: number) => `cache:product:${id}`,
};

export function getProducts() {
  return cached(productCacheKeys.all, PRODUCT_CACHE_TTL_SECONDS, () =>
    prisma.product.findMany({
      orderBy: {
        id: "asc",
      },
    }),
  );
}

export async function getProductById(id: number) {
  const product = await cached(productCacheKeys.one(id), PRODUCT_CACHE_TTL_SECONDS, () =>
    prisma.product.findUnique({ where: { id } }),
  );
  // "Not found" is cached too (as null) for the TTL: hammering a non-existent
  // id can't turn into a stream of DB queries. createProduct invalidates it.
  if (!product) throw new NotFoundError("Product not found");
  return product;
}

interface CreateProductInput {
  name: string;
  description?: string;
  pricePaise: number;
  quantity: number;
}

export async function createProduct(input: CreateProductInput) {
  const created = await prisma.$transaction(async (tx) => {
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

  // Invalidate AFTER the commit. Doing it inside the transaction would let a
  // concurrent reader re-fill the cache from the not-yet-committed (old) data.
  await invalidate(productCacheKeys.all, productCacheKeys.one(created.id));

  return created;
}
