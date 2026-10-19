import { Injectable } from "@nestjs/common";
import { QueryPreprocessorService } from "./query-preprocessor.service";
import { InjectionVerdict } from "./injection-classifier.service";
import { isExplicitLawQuery } from "./retrieval.service";
import { ConversationService } from "../conversation/conversation.service";
import {
  ConversationMessage,
  DocumentCategory,
} from "../memory/memory.types";
import type { PrecomputedQuery } from "./answer.service";

export interface PreparedChat {
  /** Shared history: preprocess context AND the stream's conversation context. */
  history: ConversationMessage[];
  /** Injection verdict — the caller decides the surface (throw vs edit). */
  verdict: InjectionVerdict;
  /** Retrieval routing for AnswerService.answerStream. */
  precomputed: PrecomputedQuery;
}

/**
 * Single entry point for the chat pipeline, shared by the Telegram
 * handleTextMessage flow, the app chat endpoint and per-document Q&A
 * (previously three hand-rolled copies of: history → last user message →
 * merged Haiku preprocess → explicit-law-citation bypass).
 *
 * History writes stay with AnswerService.answerStream (single writer);
 * injection handling stays with the caller (Telegram edits the placeholder,
 * the app endpoints throw 400).
 */
@Injectable()
export class ChatPipelineService {
  constructor(
    private readonly queryPreprocessor: QueryPreprocessorService,
    private readonly conversation: ConversationService,
  ) {}

  async prepare(
    userId: string,
    question: string,
    overrides?: { category?: DocumentCategory; docvaultId?: string },
  ): Promise<PreparedChat> {
    const history = await this.conversation.getHistory(userId);
    const lastUserMessage =
      history.filter((m) => m.role === "user").slice(-1)[0]?.content ?? "";

    const preprocessed = await this.queryPreprocessor.preprocess(
      question,
      lastUserMessage,
    );

    // Explicit legal citations ("§ 573 BGB …") skip the Haiku rewrite: the
    // original wording is already the optimal retrieval key, and the rewrite
    // can paraphrase away the § reference that the normKey filter keys on.
    // The injection verdict above still applies — only the search query
    // source changes.
    return {
      history,
      verdict: preprocessed.verdict,
      precomputed: {
        searchQuery: isExplicitLawQuery(question)
          ? question
          : preprocessed.rewrittenQuery,
        formattedQuery: preprocessed.formattedQuery,
        category: overrides?.category ?? preprocessed.category,
        docvaultId: overrides?.docvaultId,
      },
    };
  }
}
