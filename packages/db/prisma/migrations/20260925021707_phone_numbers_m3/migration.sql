/*
  Warnings:

  - You are about to drop the column `monthlyCost` on the `PhoneNumber` table. All the data in the column will be lost.
  - You are about to drop the column `telnyxId` on the `PhoneNumber` table. All the data in the column will be lost.
  - Added the required column `provider` to the `PhoneNumber` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "NumberType" AS ENUM ('LOCAL', 'TOLL_FREE');

-- CreateEnum
CREATE TYPE "NumberStatus" AS ENUM ('PENDING', 'ACTIVE', 'FAILED', 'RELEASED');

-- DropIndex
DROP INDEX "PhoneNumber_e164_key";

-- DropIndex
DROP INDEX "PhoneNumber_telnyxId_key";

-- DropIndex
DROP INDEX "PhoneNumber_tenantId_idx";

-- AlterTable
ALTER TABLE "PhoneNumber" DROP COLUMN "monthlyCost",
DROP COLUMN "telnyxId",
ADD COLUMN     "carrierCost" DECIMAL(10,4) NOT NULL DEFAULT 0,
ADD COLUMN     "label" TEXT,
ADD COLUMN     "monthlyPrice" DECIMAL(10,4) NOT NULL DEFAULT 0,
ADD COLUMN     "provider" TEXT NOT NULL,
ADD COLUMN     "providerNumberId" TEXT,
ADD COLUMN     "providerOrderId" TEXT,
ADD COLUMN     "status" "NumberStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "type" "NumberType" NOT NULL DEFAULT 'LOCAL';

-- CreateIndex
CREATE INDEX "PhoneNumber_tenantId_status_idx" ON "PhoneNumber"("tenantId", "status");

-- CreateIndex
CREATE INDEX "PhoneNumber_e164_idx" ON "PhoneNumber"("e164");

-- A number can be owned by only one customer at a time; released numbers may be bought again later.
CREATE UNIQUE INDEX "PhoneNumber_e164_live_key" ON "PhoneNumber"("e164") WHERE "status" IN ('PENDING', 'ACTIVE');
