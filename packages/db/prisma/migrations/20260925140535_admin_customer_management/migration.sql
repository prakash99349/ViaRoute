-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "includedNumbers" INTEGER,
ADD COLUMN     "maxConcurrentCalls" INTEGER,
ADD COLUMN     "maxNumbers" INTEGER,
ADD COLUMN     "numberPriceLocal" DECIMAL(10,2),
ADD COLUMN     "numberPriceTollFree" DECIMAL(10,2),
ADD COLUMN     "perMinuteRate" DECIMAL(10,4),
ADD COLUMN     "suspendReason" TEXT;

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "refundOfId" UUID;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "disabledAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "TenantNote" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "authorId" UUID,
    "authorName" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TenantNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TenantNote_tenantId_createdAt_idx" ON "TenantNote"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_refundOfId_key" ON "Transaction"("refundOfId");

-- AddForeignKey
ALTER TABLE "TenantNote" ADD CONSTRAINT "TenantNote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

