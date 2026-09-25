-- CreateEnum
CREATE TYPE "ProviderType" AS ENUM ('TELNYX', 'TEST');

-- CreateEnum
CREATE TYPE "ProviderStatus" AS ENUM ('ACTIVE', 'DRAINING', 'DISABLED');

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "carrierCost" DECIMAL(10,4) NOT NULL DEFAULT 0,
ADD COLUMN     "providerId" UUID;

-- AlterTable
ALTER TABLE "PhoneNumber" ADD COLUMN     "providerId" UUID;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "providerId" UUID;

-- CreateTable
CREATE TABLE "Provider" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" "ProviderType" NOT NULL,
    "status" "ProviderStatus" NOT NULL DEFAULT 'ACTIVE',
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "credentials" TEXT,
    "credentialHint" TEXT,
    "inboundPerMinute" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "outboundPerMinute" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "numberLocalMonthly" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "numberTollFreeMonthly" DECIMAL(10,4) NOT NULL DEFAULT 0,
    "lastWebhookAt" TIMESTAMP(3),
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Provider_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Call_providerId_startedAt_idx" ON "Call"("providerId", "startedAt");

-- AddForeignKey
ALTER TABLE "Tenant" ADD CONSTRAINT "Tenant_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PhoneNumber" ADD CONSTRAINT "PhoneNumber_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;
