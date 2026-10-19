import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import {
  AnswerService,
  VALID_CATEGORIES,
} from "../rag/answer.service";
import { ChatPipelineService } from "../rag/chat-pipeline.service";
import { PrismaService } from "../prisma/prisma.service";
import { DocumentCategory, UserLang } from "../memory/memory.types";
import { fingerprint } from "../common/log-fingerprint";

/**
 * Per-document Q&A for the macOS companion app (`POST
 * /app/v1/documents/:id/ask`): "what does THIS letter say about X?".
 *
 * Mirrors the app-chat flow (merged Haiku preprocessing with injection
 * verdict, explicit-law-citation bypass, shared conversation history) but
 * scopes retrieval to the one document: the docvault leg and the injected
 * document summaries are narrowed via `PrecomputedQuery.docvaultId`, while
 * the law-corpus leg and memory/diary recall stay global. History writes are
 * left to `AnswerService.answerStream` (single writer — see AppChatService).
 */
@Injectable()
export class AppDocumentAskService {
  private readonly logger = new Logger(AppDocumentAskService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly answerService: AnswerService,
    private readonly chatPipeline: ChatPipelineService,
  ) {}

  async ask(
    userId: string,
    documentId: string,
    question: string,
    language?: UserLang,
  ): Promise<string> {
    // Ownership first: fail fast before spending a preprocessor call, and
    // never let one user scope retrieval to another user's document.
    const doc = await this.prisma.userDocument.findFirst({
      where: { id: documentId, userId },
      select: { id: true, category: true },
    });
    if (!doc) {
      throw new BadRequestException("Document not found");
    }

    // The document's own category focuses the law-corpus leg; fall back to
    // the preprocessor guess when the stored value is not a known category.
    const docCategory = VALID_CATEGORIES.has(
      doc.category as DocumentCategory,
    )
      ? (doc.category as DocumentCategory)
      : undefined;

    const { history, verdict, precomputed } = await this.chatPipeline.prepare(
      userId,
      question,
      { category: docCategory, docvaultId: doc.id },
    );
    if (verdict === "INJECTION") {
      this.logger.warn(
        `Injection attempt from document ask for user ${userId}: ${fingerprint(question)}`,
      );
      throw new BadRequestException(
        "Question rejected: prompt injection detected",
      );
    }

    let answer = "";
    try {
      for await (const chunk of this.answerService.answerStream(
        question,
        userId,
        language,
        precomputed,
        history,
      )) {
        answer += chunk;
      }
    } catch (err) {
      // answerStream errors otherwise surface as bare 500s — log the
      // document scope so failures are attributable in production logs.
      this.logger.error(
        `Document ask failed for document ${documentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }

    return answer;
  }
}
