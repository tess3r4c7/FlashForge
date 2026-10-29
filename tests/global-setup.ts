import { execSync } from "node:child_process";
import pg from "pg";
import { getTestDatabaseUrl } from "./test-db.js";

/**
 * Runs ONCE before the whole test run (not per file), in the main Vitest
 * process. Prepares a clean, migrated test database:
 *
 *   1. CREATE DATABASE flashforge_test   (only if it doesn't exist yet)
 *   2. prisma migrate deploy             (apply all migrations, non-interactive)
 *   3. TRUNCATE every table              (start from a known empty state)
 *   4. insert user #1                    (the tests place orders as user 1)
 */
export default async function setup() {
  const testUrl = getTestDatabaseUrl();
  const dbName = new URL(testUrl).pathname.slice(1);

  // 1. Connect to the built-in "postgres" database to create ours.
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (exists.rowCount === 0) {
      // Identifiers can't be query parameters; dbName comes from our own config.
      await admin.query(`CREATE DATABASE "${dbName}"`);
      console.log(`[global-setup] created database ${dbName}`);
    }
  } finally {
    await admin.end();
  }

  // 2. `migrate deploy` (unlike `migrate dev`) never prompts and never resets:
  //    it just applies pending migrations. It's what you'd run in CI/production.
  execSync("npx prisma migrate deploy --config prisma7.config.ts", {
    env: { ...process.env, DATABASE_URL: testUrl },
    stdio: "pipe",
  });

  // 3 + 4. Wipe and seed.
  const db = new pg.Client({ connectionString: testUrl });
  await db.connect();
  try {
    await db.query(`
      TRUNCATE "Payment", "OrderItem", "Order", "Inventory", "Product",
               "OutboxEvent", "ProcessedEvent", "IdempotencyKey", "User"
      RESTART IDENTITY CASCADE
    `);
    await db.query(`
      INSERT INTO "User" (id, email, "updatedAt")
      VALUES (1, 'test-user@flashforge.dev', now())
    `);
    // We inserted id=1 by hand, so move the sequence past it.
    await db.query(`SELECT setval(pg_get_serial_sequence('"User"', 'id'), 1)`);
  } finally {
    await db.end();
  }
}
