-- Restore HNSW ANN indexes dropped in 20260324234006_init and 20260325183953_update.
-- CONCURRENTLY avoids locking the table for reads/writes during the build; cannot
-- run inside a transaction block, so this file must be applied via psql, not
-- `prisma migrate deploy` (see Task 2).

CREATE INDEX CONCURRENTLY IF NOT EXISTS "LawChunk_embedding_hnsw_idx"
  ON "LawChunk" USING hnsw (embedding vector_cosine_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS "UserMemory_embedding_hnsw_idx"
  ON "UserMemory" USING hnsw (embedding vector_cosine_ops);
