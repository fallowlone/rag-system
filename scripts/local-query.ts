/**
 * Local validation harness: real RetrievalService (BGE-M3 embed + pgvector +
 * BGE rerank + lawId/room filters) against the restored dump, then Claude
 * generation via the real AnswerService.answerDirect(). No Telegram, no queues.
 *
 * Run:
 *   DATABASE_URL=postgresql://postgres:ragpass@localhost:5434/lawrag \
 *   REDIS_URL=redis://localhost:6380 \
 *   npx ts-node scripts/local-query.ts "<question>"
 */
import "dotenv/config";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { CacheModule } from "../src/cache/cache.module";
import { PrismaModule } from "../src/prisma/prisma.module";
import { RagModule } from "../src/rag/rag.module";
import { ConversationModule } from "../src/conversation/conversation.module";
import { RetrievalService } from "../src/rag/retrieval.service";
import { AnswerService } from "../src/rag/answer.service";

@Module({
  imports: [CacheModule, PrismaModule, RagModule, ConversationModule],
})
class QueryModule {}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8").trim()));
  });
}

async function main(): Promise<void> {
  const argQuestion = process.argv.slice(2).join(" ").trim();
  const question = argQuestion || (await readStdin());
  if (!question) {
    process.stderr.write('usage: ts-node scripts/local-query.ts "<question>" OR pipe via stdin\n');
    process.exit(1);
  }

  const app = await NestFactory.createApplicationContext(QueryModule, {
    logger: ["error", "warn"],
  });

  const retrieval = app.get(RetrievalService);
  const answer = app.get(AnswerService);

  const t0 = Date.now();
  const chunks = await retrieval.searchUnified(question);
  const tRetrieved = Date.now();

  // Print retrieval result immediately — proves the local pipeline even if
  // generation fails (e.g. Anthropic billing).
  process.stderr.write(
    `\n[retrieval ${((tRetrieved - t0) / 1000).toFixed(1)}s | ${chunks.length} chunks]\n`,
  );
  chunks.forEach((c, i) =>
    process.stderr.write(
      `  ${i + 1}. ${c.lawId}/${c.normKey} sim=${c.similarity.toFixed(3)} | ${(c.heading ?? "").slice(0, 50)}\n`,
    ),
  );

  const reply = await answer.answerDirect(question, chunks);
  const tAnswered = Date.now();
  process.stderr.write(
    `[generation ${((tAnswered - tRetrieved) / 1000).toFixed(1)}s]\n\n`,
  );
  process.stdout.write(reply + "\n");

  await app.close();
}

main().catch((err: unknown) => {
  process.stderr.write(
    "FAILED: " + (err instanceof Error ? err.stack ?? err.message : String(err)) + "\n",
  );
  process.exit(1);
});
