-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "recordingDeletedAt" TIMESTAMP(3),
ADD COLUMN     "recordingSize" INTEGER;

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "playRecordingNotice" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "recordingNotice" TEXT;

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "recordingRetentionDays" INTEGER DEFAULT 90;
