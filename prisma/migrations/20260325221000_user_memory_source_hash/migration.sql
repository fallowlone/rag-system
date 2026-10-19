-- Add sourceHash column to UserMemory for document deduplication
ALTER TABLE "UserMemory" ADD COLUMN "sourceHash" TEXT;

-- Partial index: only index rows where sourceHash is set (document/photo memories)
-- Speeds up the duplicate check: WHERE "userId" = ? AND "sourceHash" = ?
CREATE INDEX "UserMemory_userId_sourceHash_idx"
    ON "UserMemory" ("userId", "sourceHash")
    WHERE "sourceHash" IS NOT NULL;
