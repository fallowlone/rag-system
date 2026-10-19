-- AlterTable
ALTER TABLE "UserDocument" ADD COLUMN "fullText" TEXT,
ADD COLUMN "summary" TEXT,
ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "expiryDate" TIMESTAMP(3);
