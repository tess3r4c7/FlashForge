// ─── Post-load-test inventory verifier (runs in Node, not k6) ───────────────
//
// k6 can only see what the HTTP API exposes, and stock levels are deliberately
// NOT exposed (see product.service.ts — stale stock in a cache is worse than
// none). So the "did we oversell?" question has to be answered where the truth
// lives: Postgres. This script cross-checks two independent records of the
// same facts:
//
//   1. The Inventory row's counters (availableQuantity, reservedQuantity)
//   2. The Order / OrderItem rows that were actually created
//
// If the atomic UPDATE ever let two requests take the same unit, these two
// records would disagree. Invariants checked (S = original stock):
//
//   available >= 0 and reserved >= 0            (no negative stock)
//   sold + open <= S                             (no overselling)
//   available + reserved + sold == S             (no unit created or lost)
//   reserved == open                             (counters match the orders)
//
//   where sold = units in CONFIRMED orders, open = units in orders that still
//   hold a reservation (PENDING / INVENTORY_RESERVED / PAYMENT_PROCESSING).
//
// Usage:
//   npx tsx loadtest/verify-db.ts --prefix "Flash Sale" --stock 10 --expect-accepted 10
//   npx tsx loadtest/verify-db.ts --product 123 --stock 500 --settle 15
//
//   --prefix            pick the most recent product whose name starts with this
//   --product           or give the id directly
//   --stock             the stock the product was created with
//   --expect-accepted   (optional) exact number of orders that should exist
//   --settle            (optional) seconds to wait for in-flight payments to
//                       finish before checking (default 0). The invariants hold
//                       at every instant anyway; settling just makes the
//                       sold/open split easier to read.

import { prisma } from "../src/lib/prisma.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

interface Snapshot {
  productId: number;
  name: string;
  available: number;
  reserved: number;
  sold: number;
  open: number;
  cancelled: number;
  orderCount: number;
}

async function findProductId(): Promise<number> {
  const id = arg("product");
  if (id) return Number(id);

  const prefix = arg("prefix");
  if (!prefix) throw new Error("Pass --product <id> or --prefix <name prefix>");

  const product = await prisma.product.findFirst({
    where: { name: { startsWith: prefix } },
    orderBy: { id: "desc" },
  });
  if (!product) throw new Error(`No product found with name starting "${prefix}"`);
  return product.id;
}

async function snapshot(productId: number): Promise<Snapshot> {
  // REPEATABLE READ: both queries see the SAME committed state. Without it the
  // worker could confirm a payment between the two reads and we'd report a
  // false mismatch (inventory read before the confirm, orders read after).
  return prisma.$transaction(
    async (tx) => {
      const product = await tx.product.findUniqueOrThrow({
        where: { id: productId },
        include: { inventory: true },
      });

      const rows = await tx.$queryRaw<{ status: string; units: bigint; orders: bigint }[]>`
        SELECT o."status"::text AS status,
               COALESCE(SUM(oi."quantity"), 0) AS units,
               COUNT(DISTINCT o."id") AS orders
        FROM "OrderItem" oi
        JOIN "Order" o ON o."id" = oi."orderId"
        WHERE oi."productId" = ${productId}
        GROUP BY o."status"
      `;

      const units = (s: string) => Number(rows.find((r) => r.status === s)?.units ?? 0);

      return {
        productId,
        name: product.name,
        available: product.inventory!.availableQuantity,
        reserved: product.inventory!.reservedQuantity,
        sold: units("CONFIRMED"),
        open: units("PENDING") + units("INVENTORY_RESERVED") + units("PAYMENT_PROCESSING"),
        cancelled: units("CANCELLED"),
        orderCount: rows.reduce((n, r) => n + Number(r.orders), 0),
      };
    },
    { isolationLevel: "RepeatableRead" },
  );
}

async function main() {
  const stock = Number(arg("stock"));
  if (!Number.isInteger(stock)) throw new Error("--stock <n> is required");
  const expectAccepted = arg("expect-accepted");
  const settleSeconds = Number(arg("settle") ?? 0);

  const productId = await findProductId();

  // Optionally wait until no order is mid-payment, so the report is stable.
  const deadline = Date.now() + settleSeconds * 1000;
  let s = await snapshot(productId);
  while (Date.now() < deadline && s.open > 0) {
    await new Promise((r) => setTimeout(r, 1000));
    s = await snapshot(productId);
  }

  const checks: [string, boolean, string][] = [
    ["available >= 0", s.available >= 0, `${s.available}`],
    ["reserved >= 0", s.reserved >= 0, `${s.reserved}`],
    ["no overselling (sold + open <= stock)", s.sold + s.open <= stock, `${s.sold} + ${s.open} <= ${stock}`],
    [
      "conservation (available + reserved + sold == stock)",
      s.available + s.reserved + s.sold === stock,
      `${s.available} + ${s.reserved} + ${s.sold} = ${s.available + s.reserved + s.sold}`,
    ],
    ["counters match orders (reserved == open units)", s.reserved === s.open, `${s.reserved} vs ${s.open}`],
  ];
  if (expectAccepted !== undefined) {
    checks.push([
      `exactly ${expectAccepted} orders accepted`,
      s.orderCount === Number(expectAccepted),
      `${s.orderCount}`,
    ]);
  }

  console.log(`\n──── Inventory verification: product #${s.productId} "${s.name}" ────`);
  console.log(`original stock ${stock} | available ${s.available} | reserved ${s.reserved} | sold ${s.sold} | cancelled ${s.cancelled} | orders ${s.orderCount}`);
  for (const [label, ok, detail] of checks) {
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}  (${detail})`);
  }
  const allOk = checks.every(([, ok]) => ok);
  console.log(allOk ? "\nAll inventory invariants hold.\n" : "\nINVENTORY INVARIANT VIOLATED.\n");

  // --out <file>: machine-readable result for the benchmark report.
  const out = arg("out");
  if (out) {
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      out,
      JSON.stringify(
        {
          ...s,
          stock,
          oversold: Math.max(0, s.sold + s.open + s.cancelled - stock),
          allOk,
          checks: checks.map(([label, ok, detail]) => ({ label, ok, detail })),
        },
        null,
        2,
      ),
    );
  }

  await prisma.$disconnect();
  process.exit(allOk ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});

