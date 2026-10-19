-- Index on LawChunk.lawId
-- Speeds up pgvector queries that filter by law (WHERE "lawId" = ?)
CREATE INDEX IF NOT EXISTS "LawChunk_lawId_idx" ON "LawChunk" ("lawId");

-- Index on UserMemory.userId
-- Critical for recall() and list() which always filter by userId
CREATE INDEX IF NOT EXISTS "UserMemory_userId_idx" ON "UserMemory" ("userId");

-- Index on UserMemory.createdAt
-- Used by list() ORDER BY "createdAt" DESC
CREATE INDEX IF NOT EXISTS "UserMemory_createdAt_idx" ON "UserMemory" ("createdAt" DESC);

-- Index on Law.lastFetched
-- Used by cron job queries: WHERE "lastFetched" IS NULL and ORDER BY "lastFetched"
CREATE INDEX IF NOT EXISTS "Law_lastFetched_idx" ON "Law" ("lastFetched");
