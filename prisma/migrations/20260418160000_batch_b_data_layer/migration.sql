-- Batch B — data layer correctness
--
-- 1. Replace global @unique on UserDocument.sourceHash with compound (userId, sourceHash).
--    The old constraint prevented two users from ever uploading the same file.
--    No backfill needed: the existing global-unique guarantee means every row already
--    satisfies the weaker compound constraint.
--
-- 2. Add composite index on UserMemory(userId, type). Most hot queries (getUserLanguage,
--    list, setUserLanguage, preference lookups) filter on this pair.
--
-- No explicit BEGIN/COMMIT — Prisma wraps multi-statement migrations in an implicit
-- transaction. IF EXISTS / IF NOT EXISTS guards keep the migration safe to re-run
-- if it partially applied before being recorded in _prisma_migrations.

-- DropIndex
DROP INDEX IF EXISTS "UserDocument_sourceHash_key";

-- CreateIndex (new compound unique)
CREATE UNIQUE INDEX IF NOT EXISTS "UserDocument_userId_sourceHash_key"
    ON "UserDocument" ("userId", "sourceHash");

-- CreateIndex (new composite for hot UserMemory reads)
CREATE INDEX IF NOT EXISTS "UserMemory_userId_type_idx"
    ON "UserMemory" ("userId", "type");
