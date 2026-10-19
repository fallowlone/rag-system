-- Speeds up parent-norm sibling lookups (retrieval.service.ts): after
-- rerank, fetch all chunks sharing a law chunk's base normKey (LIKE
-- 'base%') to enrich the prompt with the full § instead of just the
-- top-ranked fragment. Previously unindexed — this query and the existing
-- docvault-status/-delete/searchDocvault LIKE queries all did a sequential
-- scan over LawChunk. text_pattern_ops so the index is usable for
-- LIKE 'prefix%' regardless of the database's collation.
-- CONCURRENTLY avoids locking the table for reads/writes during the build;
-- cannot run inside a transaction block, so this file must be applied via
-- psql, not `prisma migrate deploy` (see 20260701120000 for precedent).
-- Not declared in schema.prisma for the same reason the HNSW indexes
-- aren't: Prisma's schema DSL can't express the text_pattern_ops opclass.

CREATE INDEX CONCURRENTLY IF NOT EXISTS "LawChunk_lawId_normKey_idx"
  ON "LawChunk" ("lawId", "normKey" text_pattern_ops);
