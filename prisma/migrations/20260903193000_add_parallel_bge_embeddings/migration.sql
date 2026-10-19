ALTER TABLE "LawChunk"
  ADD COLUMN "embeddingBge" vector(1024);

ALTER TABLE "UserMemory"
  ADD COLUMN "embeddingBge" vector(1024);

ALTER TABLE "UserDiary"
  ADD COLUMN "embeddingBge" vector(1024);

CREATE INDEX "LawChunk_embeddingBge_hnsw_idx"
  ON "LawChunk" USING hnsw ("embeddingBge" vector_cosine_ops);

CREATE INDEX "UserMemory_embeddingBge_hnsw_idx"
  ON "UserMemory" USING hnsw ("embeddingBge" vector_cosine_ops);

CREATE INDEX "UserDiary_embeddingBge_hnsw_idx"
  ON "UserDiary" USING hnsw ("embeddingBge" vector_cosine_ops);
