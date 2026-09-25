-- AlterTable
ALTER TABLE "Buyer" ADD COLUMN     "concurrencyCap" INTEGER,
ADD COLUMN     "dailyCap" INTEGER,
ADD COLUMN     "hourlyCap" INTEGER,
ADD COLUMN     "monthlyCap" INTEGER;

-- AlterTable
ALTER TABLE "Target" ADD COLUMN     "dailyCap" INTEGER,
ADD COLUMN     "hourlyCap" INTEGER,
ADD COLUMN     "monthlyCap" INTEGER,
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 1;
