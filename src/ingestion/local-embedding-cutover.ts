import { Prisma, PrismaClient } from "@prisma/client";
import { z } from "zod";
import {
  LOCAL_EMBEDDING_MODEL,
  LOCAL_EMBEDDING_REVISION,
  LOCAL_RERANKER_MODEL,
  LOCAL_RERANKER_REVISION,
  LOCAL_RETRIEVAL_DEFAULT_URL,
  LOCAL_RETRIEVAL_HEALTH_TIMEOUT_MS,
} from "../config/local-retrieval.constants";

interface CoverageRow {
  tableName: string;
  total: number;
  missing: number;
}

interface IndexRow {
  indexName: string;
  tableName: string;
  schemaName: string;
  valid: boolean;
  ready: boolean;
  definition: string;
}

export interface LocalEmbeddingCutoverReport {
  coverage: CoverageRow[];
  indexes: IndexRow[];
}

const EXPECTED_INDEXES = [
  { indexName: "LawChunk_embeddingBge_hnsw_idx", tableName: "LawChunk" },
  { indexName: "UserMemory_embeddingBge_hnsw_idx", tableName: "UserMemory" },
  { indexName: "UserDiary_embeddingBge_hnsw_idx", tableName: "UserDiary" },
] as const;

const RetrievalHealthSchema = z.object({
  status: z.literal("ok"),
  embeddingModel: z.literal(LOCAL_EMBEDDING_MODEL),
  embeddingRevision: z.literal(LOCAL_EMBEDDING_REVISION),
  rerankerModel: z.literal(LOCAL_RERANKER_MODEL),
  rerankerRevision: z.literal(LOCAL_RERANKER_REVISION),
});

type QueryClient = Pick<PrismaClient, "$queryRaw">;

export async function assertLocalEmbeddingDatabaseReady(
  prisma: QueryClient,
): Promise<LocalEmbeddingCutoverReport> {
  const coverage = await prisma.$queryRaw<CoverageRow[]>(Prisma.sql`
    SELECT
      'LawChunk'::text AS "tableName",
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE "embeddingBge" IS NULL)::int AS missing
    FROM "LawChunk"
    UNION ALL
    SELECT
      'UserMemory'::text AS "tableName",
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE "embeddingBge" IS NULL)::int AS missing
    FROM "UserMemory"
    UNION ALL
    SELECT
      'UserDiary'::text AS "tableName",
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE "embeddingBge" IS NULL)::int AS missing
    FROM "UserDiary"
  `);

  const incomplete = coverage.filter((row) => row.missing > 0);
  if (incomplete.length > 0) {
    const details = incomplete
      .map((row) => `${row.tableName}=${row.missing}`)
      .join(", ");
    throw new Error(
      `Local embedding cutover is incomplete: ${details}. Run the BGE-M3 backfill before starting the application.`,
    );
  }

  const indexes = await prisma.$queryRaw<IndexRow[]>(Prisma.sql`
    SELECT
      index_class.relname::text AS "indexName",
      table_class.relname::text AS "tableName",
      index_namespace.nspname::text AS "schemaName",
      pg_index.indisvalid AS valid,
      pg_index.indisready AS ready,
      pg_get_indexdef(pg_index.indexrelid)::text AS definition
    FROM pg_index
    JOIN pg_class AS index_class ON index_class.oid = pg_index.indexrelid
    JOIN pg_class AS table_class ON table_class.oid = pg_index.indrelid
    JOIN pg_namespace AS index_namespace ON index_namespace.oid = index_class.relnamespace
    JOIN pg_namespace AS table_namespace ON table_namespace.oid = table_class.relnamespace
    WHERE index_class.relname IN (
      'LawChunk_embeddingBge_hnsw_idx',
      'UserMemory_embeddingBge_hnsw_idx',
      'UserDiary_embeddingBge_hnsw_idx'
    )
      AND index_namespace.nspname = 'public'
      AND table_namespace.nspname = 'public'
  `);

  const byName = new Map(indexes.map((row) => [row.indexName, row]));
  const invalidIndexes = EXPECTED_INDEXES.flatMap(({ indexName, tableName }) => {
    const row = byName.get(indexName);
    if (!row) return [`${indexName}=missing`];
    if (row.schemaName !== "public" || row.tableName !== tableName) {
      return [
        `${indexName}=unexpected-target:${row.schemaName}.${row.tableName}`,
      ];
    }
    if (!row.valid || !row.ready) {
      return [`${indexName}=valid:${row.valid},ready:${row.ready}`];
    }
    // pg_get_indexdef formatting (spacing, quoting, opclass order) varies
    // across PG/pgvector versions — match the structure with a tolerant
    // regex, not exact substrings, so a formatting change can't turn into
    // a boot refusal.
    const normalized = row.definition.replace(/\s+/g, " ");
    if (
      !/USING\s+hnsw/i.test(normalized) ||
      !/"embeddingBge"\s+vector_cosine_ops/i.test(normalized)
    ) {
      return [`${indexName}=unexpected-definition`];
    }
    return [];
  });

  if (invalidIndexes.length > 0) {
    throw new Error(
      `Local embedding cutover indexes are not ready: ${invalidIndexes.join(", ")}`,
    );
  }

  return { coverage, indexes };
}

export async function assertLocalRetrievalServiceReady(): Promise<void> {
  const baseUrl = normalizeBaseUrl(
    process.env.LOCAL_RETRIEVAL_URL ?? LOCAL_RETRIEVAL_DEFAULT_URL,
  );
  const response = await fetch(`${baseUrl}/health`, {
    signal: AbortSignal.timeout(LOCAL_RETRIEVAL_HEALTH_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Local retrieval health check failed with HTTP ${response.status}`);
  }
  RetrievalHealthSchema.parse(await response.json());
}

export async function assertLocalRetrievalCutoverReady(
  prisma: QueryClient,
): Promise<LocalEmbeddingCutoverReport> {
  const report = await assertLocalEmbeddingDatabaseReady(prisma);
  await assertLocalRetrievalServiceReady();
  return report;
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, "");
}
