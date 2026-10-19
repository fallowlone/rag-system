-- Enable pgvector extension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateTable
CREATE TABLE "Law" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "xmlUrl" TEXT NOT NULL,
    "lastFetched" TIMESTAMP(3),
    "checksum" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Law_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LawChunk" (
    "id" TEXT NOT NULL,
    "lawId" TEXT NOT NULL,
    "normKey" TEXT NOT NULL,
    "heading" TEXT,
    "text" TEXT NOT NULL,
    "embedding" vector(1024),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LawChunk_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "LawChunk" ADD CONSTRAINT "LawChunk_lawId_fkey"
    FOREIGN KEY ("lawId") REFERENCES "Law"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- HNSW index for fast approximate nearest-neighbour cosine search
CREATE INDEX "LawChunk_embedding_hnsw_idx"
    ON "LawChunk" USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
