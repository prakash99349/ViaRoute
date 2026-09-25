-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "ivrData" JSONB,
ADD COLUMN     "ivrPath" TEXT;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "ivr" JSONB,
ADD COLUMN     "whisperText" TEXT;
