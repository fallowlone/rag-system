import { PrismaClient } from "@prisma/client";
import {
  assertLocalEmbeddingDatabaseReady,
  assertLocalRetrievalServiceReady,
} from "./local-embedding-cutover";
import {
  LOCAL_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_REVISION,
  LOCAL_RERANKER_MODEL,
  LOCAL_RERANKER_REVISION,
} from "../config/local-retrieval.constants";

describe("local embedding cutover preflight", () => {
  const originalFetch = global.fetch;
  const originalEnv = process.env;

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  function validCoverage() {
    return [
      { tableName: "LawChunk", total: 100, missing: 0 },
      { tableName: "UserMemory", total: 10, missing: 0 },
      { tableName: "UserDiary", total: 0, missing: 0 },
    ];
  }

  function validIndexes() {
    return [
      ["LawChunk_embeddingBge_hnsw_idx", "LawChunk"],
      ["UserMemory_embeddingBge_hnsw_idx", "UserMemory"],
      ["UserDiary_embeddingBge_hnsw_idx", "UserDiary"],
    ].map(([indexName, tableName]) => ({
      indexName,
      tableName,
      schemaName: "public",
      valid: true,
      ready: true,
      definition: `CREATE INDEX "${indexName}" ON public."${tableName}" USING hnsw ("embeddingBge" vector_cosine_ops)`,
    }));
  }

  it("accepts complete coverage with all expected ready HNSW indexes", async () => {
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce(validCoverage())
        .mockResolvedValueOnce(validIndexes()),
    } as unknown as PrismaClient;

    await expect(assertLocalEmbeddingDatabaseReady(prisma)).resolves.toMatchObject({
      coverage: validCoverage(),
    });
  });

  it("rejects a missing or invalid BGE HNSW index", async () => {
    const indexes = validIndexes().slice(1);
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce(validCoverage())
        .mockResolvedValueOnce(indexes),
    } as unknown as PrismaClient;

    await expect(assertLocalEmbeddingDatabaseReady(prisma)).rejects.toThrow(
      "LawChunk_embeddingBge_hnsw_idx=missing",
    );
  });

  it("tolerates pg_get_indexdef formatting variants (spacing/case)", async () => {
    const indexes = validIndexes();
    indexes[0] = {
      ...indexes[0],
      definition: `CREATE INDEX "LawChunk_embeddingBge_hnsw_idx" ON public."LawChunk"  USING  hNsw  ("embeddingBge"   vector_cosine_ops)`,
    };
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce(validCoverage())
        .mockResolvedValueOnce(indexes),
    } as unknown as PrismaClient;

    await expect(
      assertLocalEmbeddingDatabaseReady(prisma),
    ).resolves.toMatchObject({ coverage: validCoverage() });
  });

  it("still rejects a wrong opclass", async () => {
    const indexes = validIndexes();
    indexes[0] = {
      ...indexes[0],
      definition: `CREATE INDEX "LawChunk_embeddingBge_hnsw_idx" ON public."LawChunk" USING hnsw ("embeddingBge" vector_l2_ops)`,
    };
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce(validCoverage())
        .mockResolvedValueOnce(indexes),
    } as unknown as PrismaClient;

    await expect(assertLocalEmbeddingDatabaseReady(prisma)).rejects.toThrow(
      "unexpected-definition",
    );
  });

  it("rejects an expected index name attached to the wrong table", async () => {
    const indexes = validIndexes();
    indexes[0] = { ...indexes[0], tableName: "UserMemory" };
    const prisma = {
      $queryRaw: jest
        .fn()
        .mockResolvedValueOnce(validCoverage())
        .mockResolvedValueOnce(indexes),
    } as unknown as PrismaClient;

    await expect(assertLocalEmbeddingDatabaseReady(prisma)).rejects.toThrow(
      "LawChunk_embeddingBge_hnsw_idx=unexpected-target:public.UserMemory",
    );
  });

  it("requires the exact pinned embedding and reranker revisions from retrieval health", async () => {
    process.env = {
      ...originalEnv,
      LOCAL_RETRIEVAL_URL: "http://retrieval.test:8000/",
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        status: "ok",
        embeddingModel: LOCAL_EMBEDDING_MODEL,
        embeddingRevision: LOCAL_EMBEDDING_REVISION,
        rerankerModel: LOCAL_RERANKER_MODEL,
        rerankerRevision: LOCAL_RERANKER_REVISION,
      }),
    }) as unknown as typeof fetch;

    await expect(assertLocalRetrievalServiceReady()).resolves.toBeUndefined();
    expect(global.fetch).toHaveBeenCalledWith(
      "http://retrieval.test:8000/health",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects retrieval health when a model revision drifts", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        status: "ok",
        embeddingModel: LOCAL_EMBEDDING_MODEL,
        embeddingRevision: "wrong-revision",
        rerankerModel: LOCAL_RERANKER_MODEL,
        rerankerRevision: LOCAL_RERANKER_REVISION,
      }),
    }) as unknown as typeof fetch;

    await expect(assertLocalRetrievalServiceReady()).rejects.toThrow();
  });
});
