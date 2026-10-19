import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { randomUUID } from "crypto";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { EmbeddingService } from "../ingestion/embedding.service";
import { PalaceNavigationService } from "./palace-navigation.service";
import { RetrievalService } from "./retrieval.service";
import { AnswerService } from "./answer.service";
import { InjectionClassifierService } from "./injection-classifier.service";
import { chunkNormText } from "../ingestion/chunk-norm-text";
import { docvaultNormKeyFilter } from "./docvault-scope";

const INGEST_BATCH_SIZE = 500;
// A single request must not OOM the embed/timeout budget: the HTTP body cap
// is 20 MB, which chunks into thousands of texts for one /embed call.
const MAX_INGEST_CHUNKS = 2000;

export interface DocvaultIngestInput {
  text: string;
  title: string;
  docvaultId: string;
  ownerUserId: string;
  category?: string;
}

/**
 * Owns the docvault (personal-document) index: ingest/status/delete against
 * `LawChunk` (`lawId = 'docvault'`), and the injection-checked
 * retrieve-then-answer path used by `/admin/docvault/query`. Extracted from
 * AdminController — the controller now only validates HTTP input and calls
 * these methods.
 */
@Injectable()
export class DocvaultService {
  private readonly logger = new Logger(DocvaultService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly embedding: EmbeddingService,
    private readonly palace: PalaceNavigationService,
    private readonly retrieval: RetrievalService,
    private readonly answerService: AnswerService,
    private readonly injectionClassifier: InjectionClassifierService,
  ) {}

  async ingest(
    input: DocvaultIngestInput,
  ): Promise<{ chunkCount: number; docvaultId: string }> {
    await this.prisma.law.upsert({
      where: { id: "docvault" },
      create: {
        id: "docvault",
        title: "DocVault Personal Documents",
        xmlUrl: "docvault://local",
      },
      update: {},
    });

    const roomId = this.palace.resolveDocvaultRoom(input.category ?? "other");

    const parsedChunks = chunkNormText(input.text, input.docvaultId, input.title);

    if (parsedChunks.length === 0) {
      throw new BadRequestException("Text produced no usable chunks");
    }

    if (parsedChunks.length > MAX_INGEST_CHUNKS) {
      throw new BadRequestException(
        `Text produced ${parsedChunks.length} chunks, max is ${MAX_INGEST_CHUNKS}`,
      );
    }

    const chunkTexts = parsedChunks.map((c) => c.text);

    try {
      const vectors = await this.embedding.embed(chunkTexts);

      // Atomic replace: delete old chunks (scoped to this owner) and insert the
      // new ones in one transaction, batched to cut per-row round trips. A
      // failure anywhere rolls back the delete too, so re-ingest never leaves
      // the document partially or fully missing from the index.
      await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`
            DELETE FROM "LawChunk"
            WHERE "lawId" = 'docvault'
              AND "ownerUserId" = ${input.ownerUserId}
              AND ${docvaultNormKeyFilter(input.docvaultId)}
          `;

          for (let i = 0; i < parsedChunks.length; i += INGEST_BATCH_SIZE) {
            const slice = parsedChunks.slice(i, i + INGEST_BATCH_SIZE);
            const rows = slice.map((chunk, j) => {
              const vector = vectors[i + j];
              if (!vector) {
                throw new Error(
                  `docvaultIngest: missing embedding for chunk index ${i + j}`,
                );
              }
              const id = randomUUID();
              const vectorStr = `[${vector.join(",")}]`;
              return Prisma.sql`(${id}::uuid, 'docvault', ${chunk.normKey}, ${chunk.heading ?? input.title}, ${chunk.text}, ${vectorStr}::vector, ${roomId}, ${input.ownerUserId}, NOW())`;
            });

            await tx.$executeRaw(
              Prisma.sql`INSERT INTO "LawChunk" (id, "lawId", "normKey", heading, text, "embeddingBge", "roomId", "ownerUserId", "createdAt") VALUES ${Prisma.join(rows)}`,
            );
          }
        },
        { timeout: 120_000 },
      );
    } catch (err) {
      this.logger.error(
        `ingest: failed to embed/insert chunks for ${input.docvaultId}`,
        err instanceof Error ? err.stack : String(err),
      );
      throw err;
    }

    this.logger.log(
      `ingest: ${parsedChunks.length} chunks for docvaultId=${input.docvaultId}`,
    );
    return { chunkCount: parsedChunks.length, docvaultId: input.docvaultId };
  }

  async status(
    docvaultId: string,
    ownerUserId: string,
  ): Promise<{ ingested: boolean; chunkCount: number; docvaultId: string }> {
    const rows = await this.prisma.$queryRaw<{ count: bigint }[]>`
      SELECT COUNT(*) AS count
      FROM "LawChunk"
      WHERE "lawId" = 'docvault'
        AND "ownerUserId" = ${ownerUserId}
        AND ${docvaultNormKeyFilter(docvaultId)}
    `;

    const chunkCount = Number(rows[0]?.count ?? 0);
    return { ingested: chunkCount > 0, chunkCount, docvaultId };
  }

  async delete(
    docvaultId: string,
    ownerUserId: string,
  ): Promise<{ deleted: number; docvaultId: string }> {
    const deleted = await this.prisma.$executeRaw`
      DELETE FROM "LawChunk"
      WHERE "lawId" = 'docvault'
        AND "ownerUserId" = ${ownerUserId}
        AND ${docvaultNormKeyFilter(docvaultId)}
    `;

    this.logger.log(`delete: ${deleted} chunks removed for docvaultId=${docvaultId}`);
    return { deleted, docvaultId };
  }

  async query(
    question: string,
    ownerUserId: string,
    docvaultId?: string,
  ): Promise<{ answer: string }> {
    try {
      const verdict = await this.injectionClassifier.classify(question);
      if (verdict === "INJECTION") {
        throw new BadRequestException("Question rejected: prompt injection detected");
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      // Fail open — classifier error should not block legitimate requests,
      // consistent with the Telegram path's trust boundary for direct questions.
      this.logger.warn(
        `Injection classifier failed for docvault query, allowing request: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const chunks = docvaultId
      ? await this.retrieval.searchDocvault(question, docvaultId, 5, ownerUserId)
      : // No docvaultId → generic law search. Docvault chunks are personal
        // documents, so the fallback must never mix in anyone's docvault rows.
        await this.retrieval.search(question);

    const answer = await this.answerService.answerDirect(question, chunks);

    return { answer };
  }
}
