-- CreateEnum
CREATE TYPE "RepeatRouting" AS ENUM ('DIFFERENT', 'SAME', 'NORMAL');

-- DropIndex
DROP INDEX "Route_campaignId_buyerId_key";

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "targetId" UUID;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "repeatRouting" "RepeatRouting" NOT NULL DEFAULT 'DIFFERENT';

-- AlterTable
ALTER TABLE "Route" ADD COLUMN     "targetId" UUID,
ALTER COLUMN "buyerId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Target" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "buyerId" UUID,
    "name" TEXT NOT NULL,
    "destinationType" "DestinationType" NOT NULL DEFAULT 'PHONE',
    "destination" TEXT NOT NULL,
    "ringTimeoutSec" INTEGER NOT NULL DEFAULT 20,
    "concurrencyCap" INTEGER,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Target_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Target_tenantId_idx" ON "Target"("tenantId");

-- CreateIndex
CREATE INDEX "Call_tenantId_callerNumber_startedAt_idx" ON "Call"("tenantId", "callerNumber", "startedAt");

-- CreateIndex
CREATE INDEX "Route_campaignId_idx" ON "Route"("campaignId");

-- AddForeignKey
ALTER TABLE "Target" ADD CONSTRAINT "Target_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Target" ADD CONSTRAINT "Target_buyerId_fkey" FOREIGN KEY ("buyerId") REFERENCES "Buyer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Route" ADD CONSTRAINT "Route_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "Target"("id") ON DELETE SET NULL ON UPDATE CASCADE;
