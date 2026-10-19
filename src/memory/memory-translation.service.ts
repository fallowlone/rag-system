import { ConflictException, Injectable, Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EmbeddingService } from "../ingestion/embedding.service";
import { embeddingColumnSql } from "../ingestion/embedding-storage";
import { logLlmUsage } from "../llm-usage";
import { HAIKU_MODEL } from "../llm-models";

const RETRANSLATE_BATCH_SIZE = 20;
// One findMany snapshot of the whole table does not scale: page through the
// backlog with a keyset cursor instead of loading every untranslated fact.
const RETRANSLATE_PAGE_SIZE = 200;
const RETRANSLATE_MODEL = HAIKU_MODEL;
const RETRANSLATE_SYSTEM =
  "Translate each item to German. " +
  "Return ONLY a valid JSON array of strings. Same order, same count. No explanation.";

/**
 * Backfills `UserMemory.contentOriginal` for facts saved before the
 * original/German split existed: translates `content` to German and moves
 * the pre-translation text into `contentOriginal`, re-embedding on the
 * German text. Extracted from AdminController
 * — the controller only exposes the
 * `/admin/retranslate` HTTP trigger.
 */
@Injectable()
export class MemoryTranslationService {
  private readonly logger = new Logger(MemoryTranslationService.name);
  private readonly anthropic: Anthropic;

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
  ) {
    this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }

  // Overlap guard: a double POST (retry, two admins) would otherwise pay
  // for the same Haiku batches twice, last-writer-wins. Set synchronously on
  // entry (before the first await), so same-process check-then-act is race-free.
  private retranslateRunning = false;

  async retranslateAll(): Promise<{ updated: number; skipped: number }> {
    if (this.retranslateRunning) {
      throw new ConflictException("Retranslate already running");
    }
    this.retranslateRunning = true;
    try {
      return await this.runRetranslate();
    } finally {
      this.retranslateRunning = false;
    }
  }

  private async runRetranslate(): Promise<{ updated: number; skipped: number }> {
    let updated = 0;
    let skipped = 0;
    // Keyset cursor over (createdAt, id): updated rows drop out of the
    // `contentOriginal IS NULL` filter behind the cursor, so paging forward
    // never revisits or skips rows. Failed batches stay untranslated behind
    // the cursor — same "skip, don't retry" semantics as the old snapshot.
    let cursor: string | undefined;
    for (;;) {
      const page = await this.prisma.userMemory.findMany({
        where: { type: "fact", contentOriginal: null },
        select: { id: true, content: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take: RETRANSLATE_PAGE_SIZE,
      });
      if (page.length === 0) break;
      cursor = page[page.length - 1]?.id;
      if (!cursor) break;

      this.logger.log(`retranslate: found ${page.length} facts to process`);

      const result = await this.retranslatePage(page);
      updated += result.updated;
      skipped += result.skipped;

      if (page.length < RETRANSLATE_PAGE_SIZE) break;
    }

    this.logger.log(`retranslate: done — updated=${updated}, skipped=${skipped}`);
    return { updated, skipped };
  }

  private async retranslatePage(
    rows: Array<{ id: string; content: string }>,
  ): Promise<{ updated: number; skipped: number }> {
    let updated = 0;
    let skipped = 0;

    for (let i = 0; i < rows.length; i += RETRANSLATE_BATCH_SIZE) {
      const batch = rows.slice(i, i + RETRANSLATE_BATCH_SIZE);
      const originals = batch.map((r) => r.content);

      let germanTexts: string[];
      try {
        const response = await this.anthropic.messages.create({
          model: RETRANSLATE_MODEL,
          max_tokens: 2048,
          system: RETRANSLATE_SYSTEM,
          messages: [{ role: "user", content: JSON.stringify(originals) }],
        });
        logLlmUsage(
          this.logger,
          "admin_retranslate",
          RETRANSLATE_MODEL,
          response.usage,
        );

        const rawText =
          response.content[0]?.type === "text"
            ? response.content[0].text.trim()
            : "[]";

        const cleaned = rawText
          .replace(/^```json\s*/i, "")
          .replace(/^```\s*/i, "")
          .replace(/```\s*$/i, "")
          .trim();

        const parsed: unknown = JSON.parse(cleaned);
        if (
          !Array.isArray(parsed) ||
          !parsed.every((f) => typeof f === "string") ||
          parsed.length !== batch.length
        ) {
          throw new Error(`array length mismatch or wrong type`);
        }
        germanTexts = parsed as string[];
      } catch (err) {
        this.logger.warn(
          `retranslate: batch ${i}–${i + batch.length - 1} failed, skipping: ${err instanceof Error ? err.message : String(err)}`,
        );
        skipped += batch.length;
        continue;
      }

      const newEmbeddings = await this.embedding.embed(germanTexts);
      if (newEmbeddings.length !== batch.length) {
        this.logger.warn(
          `retranslate: batch ${i}–${i + batch.length - 1} embedding count mismatch, skipping`,
        );
        skipped += batch.length;
        continue;
      }
      const embeddingColumn = embeddingColumnSql();

      for (let j = 0; j < batch.length; j++) {
        const row = batch[j]!;
        const germanContent = germanTexts[j]!;
        const vector = newEmbeddings[j]!;
        const vectorStr = `[${vector.join(",")}]`;

        await this.prisma.$executeRaw(Prisma.sql`
          UPDATE "UserMemory"
          SET content = ${germanContent},
              "contentOriginal" = ${row.content},
              ${embeddingColumn} = ${vectorStr}::vector,
              embedding = NULL
          WHERE id = ${row.id}
        `);
        updated++;
      }

      this.logger.log(
        `retranslate: processed batch ${i}–${i + batch.length - 1} (${updated} updated so far)`,
      );
    }

    return { updated, skipped };
  }
}
