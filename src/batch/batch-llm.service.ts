import { Injectable, Logger } from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { ConversationBlock } from "./batch.types";
import { logLlmUsage } from "../llm-usage";
import { HAIKU_MODEL, SONNET_MODEL } from "../llm-models";
import { hitOutputBudget } from "../common/llm-stop";

const HAIKU_BLOCK_SUMMARY_SYSTEM = [
  "<role>Block summarizer for legal-consultation chat.</role>",
  "<task>Summarize this conversation block in 2-4 short German sentences.",
  "Focus on: legal topics raised, personal facts mentioned, decisions, deadlines.",
  "Skip greetings and meta-chatter.</task>",
  "<output>Plain text summary only. No headers, no bullet points.</output>",
].join("\n");

const SONNET_DIARY_SYSTEM = [
  "<role>End-of-day diary writer using AAAK compression.</role>",
  "<task>Combine the per-block summaries below into a single AAAK-style diary entry for the day.",
  "AAAK = pipe-separated tags + 3-letter codes + ★-importance + emotional markers in *asterisks*.",
  "Cover: TOPICS (legal areas discussed), FACTS (new personal facts), DEADLINES (mentioned dates),",
  "DECISIONS (anything resolved), MOOD (overall tone, marked *warm/tense/raw* etc).",
  "Keep it under 400 characters. German abbreviations OK.</task>",
  "<output>Single AAAK line. No prose. No explanation.</output>",
].join("\n");

const SONNET_FACT_EXTRACTOR_SYSTEM = [
  "<role>Personal-fact extractor for legal-consultation chat.</role>",
  "<task>Extract personal facts from a day of conversation summaries.",
  "Include: visa types, permit numbers, addresses, employment, family situation,",
  "appointments, deadlines, financial amounts, ongoing legal matters.",
  "Exclude: questions, hypotheticals, generic legal info.",
  "Each fact must be self-contained, written in German, third-person where natural.",
  "A real-time extractor already ran on each individual message today and saved",
  "obvious single-message facts — they are listed in <already_known> below. Do NOT",
  "repeat them, including paraphrases of the same fact. Focus on facts that only",
  "become clear from combining multiple messages or blocks (e.g. a date mentioned",
  "in one message and its context/purpose mentioned in another).</task>",
  '<output>Return ONLY a JSON array of strings — new facts only. Empty array [] if',
  "nothing new. No markdown, no explanation.</output>",
].join("\n");

function buildFactExtractorSystem(existingFacts: string[]): string {
  if (existingFacts.length === 0) return SONNET_FACT_EXTRACTOR_SYSTEM;
  const known = existingFacts.map((f) => `- ${f}`).join("\n");
  return `${SONNET_FACT_EXTRACTOR_SYSTEM}\n<already_known>\n${known}\n</already_known>`;
}

// Input bounds for the two per-night Sonnet calls. Block summaries are
// ~2-4 sentences each, but a marathon chat day (or a prompt-injection blob
// pasted into chat) could otherwise turn one night into a context-limit
// error — which then marks the whole day failed and burns a retry.
const MAX_SUMMARIES_PER_CALL = 50;
const MAX_SONNET_INPUT_CHARS = 24_000;

export interface BlockSummary {
  summary: string;
  startedAt: Date;
  endedAt: Date;
  messageCount: number;
}

@Injectable()
export class BatchLlmService {
  private readonly logger = new Logger(BatchLlmService.name);
  private readonly anthropic: Anthropic;

  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    this.anthropic = new Anthropic({ apiKey });
  }

  async summarizeBlock(block: ConversationBlock): Promise<BlockSummary> {
    const transcript = block.messages
      .map((m) => `${m.role}: ${m.content}`)
      .join("\n");

    const response = await this.anthropic.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 256,
      system: HAIKU_BLOCK_SUMMARY_SYSTEM,
      messages: [{ role: "user", content: transcript }],
    });
    logLlmUsage(this.logger, "batch_summarize", HAIKU_MODEL, response.usage);

    // A block summary cut at 256 tokens ends mid-sentence and is then cached
    // for 36 h and fed to writeDiary/extractFacts as if it were the whole
    // block. Log it — the summary is still the best available record of that
    // block, so keeping the fragment beats dropping the block entirely, but
    // it must not pass unnoticed.
    if (hitOutputBudget(response)) {
      this.logger.warn(
        `summarizeBlock hit the 256-token budget for a ${block.messages.length}-message block — summary is truncated`,
      );
    }

    const text = extractText(response);
    return {
      summary: text.trim(),
      startedAt: block.startedAt,
      endedAt: block.endedAt,
      messageCount: block.messages.length,
    };
  }

  async writeDiary(summaries: BlockSummary[]): Promise<string> {
    const capped = summaries.slice(-MAX_SUMMARIES_PER_CALL);
    if (capped.length < summaries.length) {
      this.logger.warn(
        `writeDiary: truncated ${summaries.length} summaries to ${capped.length}`,
      );
    }
    const merged = capped
      .map((s, i) => `Block ${i + 1} (${s.startedAt.toISOString()}): ${s.summary}`)
      .join("\n")
      .slice(0, MAX_SONNET_INPUT_CHARS);

    const response = await this.anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: 512,
      system: SONNET_DIARY_SYSTEM,
      messages: [{ role: "user", content: merged }],
    });
    logLlmUsage(this.logger, "batch_diary", SONNET_MODEL, response.usage);

    if (response.stop_reason === "refusal") {
      this.logger.warn("writeDiary refused by safety classifier — skipping diary");
      return "";
    }

    // A diary entry cut at the budget is a fragment persisted as the user's
    // day. Skip it, exactly as the refusal path does: no diary is honest,
    // half a diary reads as complete.
    if (hitOutputBudget(response)) {
      this.logger.warn("writeDiary hit the 512-token budget — skipping diary");
      return "";
    }

    return extractText(response).trim();
  }

  /**
   * `existingFacts` — facts the real-time path (`UserMemoryService.extractAndSave`)
   * already saved for this user today. Passed as context so this call only
   * returns genuinely new facts instead of re-extracting (and re-paying for)
   * the same single-message facts the real-time path already caught — which
   * also avoids paraphrase drift landing the same fact in the conflict
   * grey-band (`insertFactMemories`' 0.55-0.85 similarity range) as a false
   * "conflict" between two wordings of one fact.
   */
  async extractFacts(
    summaries: BlockSummary[],
    existingFacts: string[] = [],
  ): Promise<string[]> {
    const cappedSummaries = summaries.slice(-MAX_SUMMARIES_PER_CALL);
    const merged = cappedSummaries
      .map((s) => s.summary)
      .join("\n")
      .slice(0, MAX_SONNET_INPUT_CHARS);
    const known = existingFacts.slice(-MAX_SUMMARIES_PER_CALL);

    const response = await this.anthropic.messages.create({
      model: SONNET_MODEL,
      max_tokens: 1_024,
      system: buildFactExtractorSystem(known),
      messages: [{ role: "user", content: merged }],
    });
    logLlmUsage(this.logger, "batch_facts", SONNET_MODEL, response.usage);

    const text = extractText(response).trim();

    try {
      const parsed: unknown = JSON.parse(text);
      if (!Array.isArray(parsed)) {
        this.logger.warn(
          `Fact extractor returned non-array JSON; treating as no facts`,
        );
        return [];
      }
      return parsed
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((s) => s.trim());
    } catch (err) {
      this.logger.warn(
        `Fact extractor JSON parse failed (${
          err instanceof Error ? err.message : String(err)
        }); raw="${text.slice(0, 120)}"`,
      );
      return [];
    }
  }
}

function extractText(response: Anthropic.Message): string {
  const block = response.content[0];
  return block && block.type === "text" ? block.text : "";
}
