-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ProviderType" ADD VALUE 'TWILIO';
ALTER TYPE "ProviderType" ADD VALUE 'SIGNALWIRE';
ALTER TYPE "ProviderType" ADD VALUE 'PLIVO';
ALTER TYPE "ProviderType" ADD VALUE 'BANDWIDTH';
ALTER TYPE "ProviderType" ADD VALUE 'VONAGE';
