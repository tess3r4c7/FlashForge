-- AlterTable
ALTER TABLE "Payment" ADD COLUMN     "recoveryAttempts" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "IdempotencyKey" (
    "userId" INTEGER NOT NULL,
    "key" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "responseStatus" INTEGER NOT NULL,
    "responseBody" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IdempotencyKey_pkey" PRIMARY KEY ("userId","key")
);

-- CreateIndex
CREATE INDEX "IdempotencyKey_createdAt_idx" ON "IdempotencyKey"("createdAt");

-- CreateIndex
CREATE INDEX "Order_status_updatedAt_idx" ON "Order"("status", "updatedAt");
