-- Cursor-based incremental sync for the macOS companion app: every row a
-- client already pulled must be re-served only when it actually changed.
-- UserDocument/UserTask already carry @updatedAt; UserDeadline did not.
ALTER TABLE "UserDeadline" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill: existing rows were "last changed" when they were created.
UPDATE "UserDeadline" SET "updatedAt" = "createdAt";

CREATE INDEX "UserDeadline_userId_updatedAt_idx" ON "UserDeadline"("userId", "updatedAt");