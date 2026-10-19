-- CreateTable
CREATE TABLE "UserMemory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "embedding" vector(1024),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserMemory_pkey" PRIMARY KEY ("id")
);

-- HNSW index for fast approximate nearest-neighbour cosine search
CREATE INDEX "UserMemory_embedding_hnsw_idx"
    ON "UserMemory" USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
