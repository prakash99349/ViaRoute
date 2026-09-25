-- AlterTable
ALTER TABLE "BlockedNumber" ADD COLUMN     "auto" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "attestation" TEXT,
ADD COLUMN     "lineType" TEXT,
ADD COLUMN     "spamScore" INTEGER;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "autoBlockShortCalls" INTEGER,
ADD COLUMN     "blockAnonymous" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "blockedPrefixes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "callerRateLimit" INTEGER,
ADD COLUMN     "callerRateWindowMin" INTEGER NOT NULL DEFAULT 60,
ADD COLUMN     "maxSpamScore" INTEGER,
ADD COLUMN     "minAttestation" TEXT,
ADD COLUMN     "shortCallSec" INTEGER NOT NULL DEFAULT 10;

-- CreateTable
CREATE TABLE "GlobalBlock" (
    "id" UUID NOT NULL,
    "pattern" TEXT NOT NULL,
    "reason" TEXT,
    "createdBy" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GlobalBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformSetting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformSetting_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "GlobalBlock_pattern_key" ON "GlobalBlock"("pattern");
