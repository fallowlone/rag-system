import "dotenv/config";
import { Logger } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { LocalEmbeddingProvider } from "../ingestion/local-embedding.provider";

const BATCH_SIZE = 512;
const logger = new Logger("LocalEmbeddingBackfill");

interface BackfillRow {
  id: string;
  text: string;
}

type BackfillTarget = "law-chunks" | "user-memory" | "user-diary";

async function loadBatch(
  prisma: PrismaClient,
  target: BackfillTarget,
): Promise<BackfillRow[]> {
  switch (target) {
    case "law-chunks":
      return prisma.$queryRaw<BackfillRow[]>(Prisma.sql`
        SELECT id, text
        FROM "LawChunk"
        WHERE "embeddingBge" IS NULL
        ORDER BY length(text), id
        LIMIT ${BATCH_SIZE}
      `);
    case "user-memory":
      return prisma.$queryRaw<BackfillRow[]>(Prisma.sql`
        SELECT id, content AS text
        FROM "UserMemory"
        WHERE "embeddingBge" IS NULL
        ORDER BY length(content), id
        LIMIT ${BATCH_SIZE}
      `);
    case "user-diary":
      return prisma.$queryRaw<BackfillRow[]>(Prisma.sql`
        SELECT id, entry AS text
        FROM "UserDiary"
        WHERE "embeddingBge" IS NULL
        ORDER BY length(entry), id
        LIMIT ${BATCH_SIZE}
      `);
  }
}

async function saveBatch(
  prisma: PrismaClient,
  target: BackfillTarget,
  rows: BackfillRow[],
  vectors: number[][],
): Promise<number> {
  if (rows.length !== vectors.length) {
    throw new Error(
      `Backfill vector count mismatch for ${target}: ${vectors.length} vectors for ${rows.length} rows`,
    );
  }

  const values = rows.map((row, index) => {
    const vector = vectors[index];
    if (!vector) {
      throw new Error(`Missing vector for ${target} row ${row.id}`);
    }
    const vectorStr = `[${vector.join(",")}]`;
    return Prisma.sql`(${row.id}, ${row.text}, ${vectorStr}::vector)`;
  });

  const valueTable = Prisma.join(values);
  switch (target) {
    case "law-chunks":
      return prisma.$executeRaw(Prisma.sql`
        UPDATE "LawChunk" AS target
        SET "embeddingBge" = source.embedding
        FROM (VALUES ${valueTable}) AS source(id, text, embedding)
        WHERE target.id = source.id
          AND target.text = source.text
          AND target."embeddingBge" IS NULL
      `);
    case "user-memory":
      return prisma.$executeRaw(Prisma.sql`
        UPDATE "UserMemory" AS target
        SET "embeddingBge" = source.embedding
        FROM (VALUES ${valueTable}) AS source(id, text, embedding)
        WHERE target.id = source.id
          AND target.content = source.text
          AND target."embeddingBge" IS NULL
      `);
    case "user-diary":
      return prisma.$executeRaw(Prisma.sql`
        UPDATE "UserDiary" AS target
        SET "embeddingBge" = source.embedding
        FROM (VALUES ${valueTable}) AS source(id, text, embedding)
        WHERE target.id = source.id
          AND target.entry = source.text
          AND target."embeddingBge" IS NULL
      `);
  }
}

async function backfillTarget(
  prisma: PrismaClient,
  provider: LocalEmbeddingProvider,
  target: BackfillTarget,
): Promise<number> {
  let total = 0;

  for (;;) {
    const rows = await loadBatch(prisma, target);
    if (rows.length === 0) return total;

    const vectors = await provider.embed(rows.map((row) => row.text));
    const updated = await saveBatch(prisma, target, rows, vectors);
    total += updated;
    logger.log(`${target}: backfilled ${total}`);
  }
}

export async function runLocalEmbeddingBackfill(): Promise<void> {
  const prisma = new PrismaClient();
  const provider = new LocalEmbeddingProvider();

  try {
    for (const target of [
      "law-chunks",
      "user-memory",
      "user-diary",
    ] as const) {
      const count = await backfillTarget(prisma, provider, target);
      logger.log(`${target}: complete (${count} rows updated)`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void runLocalEmbeddingBackfill().catch((err: unknown) => {
    logger.error(
      `Local embedding backfill failed: ${err instanceof Error ? err.message : String(err)}`,
      err instanceof Error ? err.stack : undefined,
    );
    process.exitCode = 1;
  });
}
