import { Injectable, Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import { CacheService } from "../cache/cache.service";
import { PrismaService } from "../prisma/prisma.service";
import { ConversationMessage } from "../memory/memory.types";
import { logLlmUsage } from "../llm-usage";
import { HAIKU_MODEL } from "../llm-models";

const SUMMARY_MODEL = HAIKU_MODEL;
const SUMMARY_MAX_TOKENS = 512;
const MAX_TOKENS = 4000;
const SUMMARY_THRESHOLD = 3000;
/**
 * Bounds one summarize→collapse cycle per user. Two overlapping addMessage
 * calls above threshold (MAX_CONCURRENT_PER_USER=3 allows 3 concurrent
 * answerStreams per user, plus app-chat sharing the same conv: key) would
 * otherwise collapse with stale readCounts: the loser's LTRIM on an
 * already-collapsed list wipes the winner's summary and the tail. 180s
 * covers a slow Haiku call with margin; the ownership token below covers
 * the case where even that expires mid-summarize.
 */
const SUMMARIZE_LOCK_TTL_SECONDS = 180;

const SUMMARIZER_SYSTEM = [
  "<role>Conversation summarizer for legal consultation system.</role>",
  "<task>Summarize this conversation history into a brief context summary in the same language as the conversation.",
  "Focus on: legal issues discussed, key facts mentioned, decisions made, pending questions.",
  "Keep it under 200 words.</task>",
  "<output>Return only the summary text, no explanation.</output>",
].join("\n");

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);
  private readonly client: Anthropic;

  constructor(
    private readonly cache: CacheService,
    private readonly prisma: PrismaService,
  ) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    this.client = new Anthropic({ apiKey });
  }

  async getHistory(userId: string): Promise<ConversationMessage[]> {
    return this.cache.getConversationHistory(userId);
  }

  async addMessage(
    userId: string,
    role: "user" | "assistant",
    content: string,
  ): Promise<void> {
    // Atomic append (RPUSH) — safe under concurrent writers (main bot flow +
    // BullMQ document processor), unlike the previous GET-array→push→SET.
    await this.cache.appendConversationMessage(userId, {
      role,
      content,
      timestamp: Date.now(),
    });

    const { messages: history, readCount } =
      await this.cache.getConversationHistoryEntries(userId);
    const totalTokens = history.reduce(
      (sum, m) => sum + estimateTokens(m.content),
      0,
    );

    if (totalTokens > SUMMARY_THRESHOLD) {
      // summarize() is a slow LLM call; messages appended concurrently while
      // it runs must survive. collapseConversationHistory only replaces the
      // `readCount` entries we actually read (LTRIM prefix + LPUSH summary),
      // so a concurrent tail is preserved instead of being wiped by a full
      // DEL-and-rewrite.
      //
      // Overlapping summarizes are still fatal: a second addMessage that
      // reads while the first summarize is in flight collapses with a stale
      // readCount, and its LTRIM wipes the winner's collapsed list. The
      // short-lived sumlock serializes the read→summarize→collapse cycle;
      // the loser keeps its append (already done above) and skips its
      // summarize — the next addMessage re-triggers it if still needed.
      const lockKey = `sumlock:${userId}`;
      // Ownership token: if this slow summarize outlives the lock TTL, the
      // retake below (not the stale readCount) decides whether collapsing is
      // still safe — a concurrent winner that already collapsed must never
      // have its summary LTRIMmed away by this loser.
      const lockToken = randomUUID();
      const locked = await this.cache.setJsonNx(
        lockKey,
        { token: lockToken, at: Date.now() },
        SUMMARIZE_LOCK_TTL_SECONDS,
      );
      if (!locked) {
        this.logger.debug(
          `Summarize skipped for user ${userId}: another summarize in flight`,
        );
      } else {
        let ownLock = true;
        try {
          const summarized = await this.summarize(userId, history);
          if (!(await this.retakeSummarizeLock(lockKey, lockToken))) {
            ownLock = false;
            this.logger.warn(
              `Summarize lock lost for user ${userId} during slow summarize — skipping collapse to protect a newer collapse`,
            );
          } else {
            await this.cache.collapseConversationHistory(
              userId,
              summarized,
              readCount,
            );
          }
        } finally {
          // Only release our own lock: deleting a foreign one would hand a
          // stale reader a free pass to collapse with an outdated readCount.
          if (ownLock) {
            try {
              await this.cache.del(lockKey);
            } catch (err) {
              this.logger.warn(
                `Summarize lock release failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
              );
            }
          }
        }
      }
    }

    // Durable linear log — feeds the nightly batch and the admin history
    // endpoint. Failure here must not break the chat UX, so we fire and log.
    void this.prisma.conversationLog
      .create({ data: { userId, role, content } })
      .catch((err: unknown) =>
        this.logger.warn(
          `ConversationLog write failed for user ${userId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );
  }

  async clearHistory(userId: string): Promise<void> {
    await this.cache.del(`conv:${userId}`);
  }

  /**
   * Re-validates lock ownership after the slow summarize call and refreshes
   * the TTL for the (fast) collapse. Returns false when another summarize
   * legitimately owns the lock now — the caller must skip its stale collapse
   * (and must not delete the foreign lock). A missing key means our TTL
   * expired with no contender: re-acquire and proceed.
   */
  private async retakeSummarizeLock(
    lockKey: string,
    lockToken: string,
  ): Promise<boolean> {
    const current = await this.cache.getJson<{ token?: unknown }>(lockKey);
    if (!current) {
      return this.cache.setJsonNx(
        lockKey,
        { token: lockToken, at: Date.now() },
        SUMMARIZE_LOCK_TTL_SECONDS,
      );
    }
    if (current.token !== lockToken) return false;
    await this.cache.setJson(
      lockKey,
      { token: lockToken, at: Date.now() },
      SUMMARIZE_LOCK_TTL_SECONDS,
    );
    return true;
  }

  private async summarize(
    userId: string,
    messages: ConversationMessage[],
  ): Promise<ConversationMessage[]> {
    this.logger.debug(
      `Summarizing conversation for user ${userId} (${messages.length} messages)`,
    );

    const userText = messages.map((m) => `${m.role}: ${m.content}`).join("\n");

    const totalTokens = estimateTokens(userText);
    if (totalTokens > MAX_TOKENS) {
      this.logger.warn(
        `Conversation for user ${userId} exceeds MAX_TOKENS (${totalTokens}), truncating before summarization`,
      );
    }

    try {
      const response = await this.client.messages.create({
        model: SUMMARY_MODEL,
        max_tokens: SUMMARY_MAX_TOKENS,
        system: SUMMARIZER_SYSTEM,
        messages: [{ role: "user", content: userText }],
      });
      logLlmUsage(this.logger, "history_summarize", SUMMARY_MODEL, response.usage);

      const block = response.content[0];
      const summary = block?.type === "text" ? block.text : "";

      return [
        {
          role: "assistant",
          content: "[История разговора]: " + summary,
          timestamp: Date.now(),
        },
      ];
    } catch (err) {
      this.logger.error(
        `Summarization failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // On failure, keep history as-is to avoid data loss
      return messages;
    }
  }
}
