-- AlterTable
ALTER TABLE "Buyer" ADD COLUMN     "email" TEXT,
ADD COLUMN     "ringTimeoutSec" INTEGER NOT NULL DEFAULT 20;

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "answeredAt" TIMESTAMP(3),
ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "connectedSec" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "dialedNumber" TEXT,
ADD COLUMN     "duplicate" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "hangupCause" TEXT,
ADD COLUMN     "outboundCallId" TEXT,
ADD COLUMN     "provider" TEXT NOT NULL DEFAULT 'telnyx',
ADD COLUMN     "routeId" UUID;

-- AlterTable
ALTER TABLE "Postback" ADD COLUMN     "succeededAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Publisher" ADD COLUMN     "postbackUrl" TEXT;

-- AlterTable
ALTER TABLE "Route" ADD COLUMN     "revenueOverride" DECIMAL(10,2);

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "billingRenewsAt" TIMESTAMP(3),
ADD COLUMN     "customDomainVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "lowBalanceNotifiedAt" TIMESTAMP(3),
ADD COLUMN     "lowBalanceThreshold" DECIMAL(10,2) NOT NULL DEFAULT 10,
ADD COLUMN     "trialEndsAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "callId" UUID;

-- CreateTable
CREATE TABLE "BlockedNumber" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "e164" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BlockedNumber_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BlockedNumber_tenantId_e164_key" ON "BlockedNumber"("tenantId", "e164");

-- CreateIndex
CREATE INDEX "Notification_tenantId_createdAt_idx" ON "Notification"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "Call_tenantId_status_idx" ON "Call"("tenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_stripeRef_key" ON "Transaction"("stripeRef");

-- AddForeignKey
ALTER TABLE "BlockedNumber" ADD CONSTRAINT "BlockedNumber_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_routeId_fkey" FOREIGN KEY ("routeId") REFERENCES "Route"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

