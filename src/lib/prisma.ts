import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "../generated/prisma/client.js";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error("DATABASE_URL is not set");
}

const adapter = new PrismaPg({
  connectionString,
});

export const prisma = new PrismaClient({
  adapter,
});

// The type of `tx` inside prisma.$transaction(async (tx) => { ... })
// It has all the same query methods as PrismaClient, minus $transaction,
// $connect, $disconnect, etc. — things that don't make sense mid-transaction.
export type TransactionClient = Prisma.TransactionClient;