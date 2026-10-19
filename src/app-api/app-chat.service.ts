import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { AnswerService } from "../rag/answer.service";
import { ChatPipelineService } from "../rag/chat-pipeline.service";
import { UserLang } from "../memory/memory.types";

/**
 * Chat endpoint for the macOS companion app. Mirrors the Telegram
 * handleTextMessage flow exactly: merged Haiku preprocessing (injection
 * verdict + query formatting + German retrieval query + category),
 * explicit-law-citation bypass of
 * the rewrite, then AnswerService.answerStream — which retrieves user
 * memories, diary, docvault documents AND the German law corpus in one
 * unified search. Conversation history is shared with the Telegram bot, so
 * both surfaces stay in one context.
 */
@Injectable()
export class AppChatService {
  private readonly logger = new Logger(AppChatService.name);

  constructor(
    private readonly answerService: AnswerService,
    private readonly chatPipeline: ChatPipelineService,
  ) {}

  async chat(
    userId: string,
    question: string,
    language?: UserLang,
  ): Promise<string> {
    const { history, verdict, precomputed } =
      await this.chatPipeline.prepare(userId, question);

    if (verdict === "INJECTION") {
      this.logger.warn(
        `Injection attempt from app chat for user ${userId}: "${question.slice(0, 80)}"`,
      );
      throw new BadRequestException(
        "Question rejected: prompt injection detected",
      );
    }

    // History writes are left to answerStream (single writer): it persists
    // the user question and the streamed answer itself. Writing here as well
    // would duplicate both turns in the shared history on every app message.
    let answer = "";
    for await (const chunk of this.answerService.answerStream(
      question,
      userId,
      language,
      precomputed,
      history,
    )) {
      answer += chunk;
    }

    return answer;
  }
}
