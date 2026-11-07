// ─── Seed: the minimum data a fresh environment needs ───────────────────────
//
// There is no signup endpoint (out of scope), so orders are placed as user #1.
// A brand-new database (fresh docker compose, CI, a new cloud environment)
// has no users, and every POST /orders would fail with "user not found".
//
// IDEMPOTENT: safe to run on every deploy. `upsert` creates user #1 if it is
// missing and leaves it alone otherwise. Never put destructive statements in
// a seed that runs automatically.
//
//   npm run db:seed                 (dev, via tsx)
//   node dist/scripts/seed.js       (container, from the compiled build)

import "dotenv/config";
import { prisma } from "../lib/prisma.js";

async function main() {
  const user = await prisma.user.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1, email: "demo@flashforge.dev" },
  });

  // Inserting an explicit id doesn't advance the SERIAL sequence; without this
  // the next auto-generated user would collide with id 1.
  await prisma.$executeRaw`
    SELECT setval(pg_get_serial_sequence('"User"', 'id'), GREATEST((SELECT MAX(id) FROM "User"), 1))
  `;

  console.log(`Seed complete: user #${user.id} (${user.email})`);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());

