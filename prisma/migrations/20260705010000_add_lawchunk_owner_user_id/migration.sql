-- AlterTable: scope docvault chunks (lawId='docvault') to their owning user.
-- NULL for shared law chunks (lawId != 'docvault').
ALTER TABLE "LawChunk" ADD COLUMN "ownerUserId" TEXT;

-- CreateIndex
CREATE INDEX "LawChunk_lawId_ownerUserId_idx" ON "LawChunk"("lawId", "ownerUserId");
