import "dotenv/config";
import { Logger } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import { assertLocalRetrievalCutoverReady } from "../ingestion/local-embedding-cutover";

const logger = new Logger("LocalEmbeddingCutoverVerifier");

export async function runLocalEmbeddingCutoverVerifier(): Promise<void> {
  const prisma = new PrismaClient();
  try {
    const report = await assertLocalRetrievalCutoverReady(prisma);
    for (const row of report.coverage) {
      logger.log(`${row.tableName}: ${row.total - row.missing}/${row.total} embedded`);
    }
    logger.log(`BGE HNSW indexes verified: ${report.indexes.length}/3`);
    logger.log("Local retrieval cutover verification complete");
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void runLocalEmbeddingCutoverVerifier().catch((err: unknown) => {
    logger.error(
      `Local retrieval cutover verification failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
      err instanceof Error ? err.stack : undefined,
    );
    process.exitCode = 1;
  });
}
