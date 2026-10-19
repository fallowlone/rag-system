import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import Anthropic from "@anthropic-ai/sdk";
import { PrismaService } from "../prisma/prisma.service";
import { logLlmUsage } from "../llm-usage";
import { hitOutputBudget } from "../common/llm-stop";
import { HAIKU_MODEL, SONNET_MODEL } from "../llm-models";
import { escapeXml } from "../rag/escape-xml";
import { AppInsightRecord } from "./app-api.types";

/**
 * The analysis model. Sonnet: document analysis is open-ended analytical
 * generation with legal nuance (grey zones, leverage points) — the task tier
 * where this codebase already pays for Sonnet (final answers), while Haiku
 * serves narrow structured transforms. Re-evaluate against
 * DOCUMENT_ANALYSIS_MODEL_CANDIDATE with scripts/doc-analysis-compare.ts
 * before changing this; the switch is this one line.
 */
export const DOCUMENT_ANALYSIS_MODEL = SONNET_MODEL;
/** Cheaper alternative for the side-by-side comparison, not the default. */
export const DOCUMENT_ANALYSIS_MODEL_CANDIDATE = HAIKU_MODEL;

/** Shared with scripts/doc-analysis-compare.ts so the harness runs the prod shape. */
export const DOCUMENT_ANALYSIS_MAX_TOKENS = 3000;
const MAX_INSIGHTS = 8;
const INSIGHT_KINDS = ["red_flag", "grey_zone", "next_step", "deadline_note"] as const;
const INSIGHT_SEVERITIES = ["high", "medium", "low"] as const;

export type InsightKind = (typeof INSIGHT_KINDS)[number];
export type InsightSeverity = (typeof INSIGHT_SEVERITIES)[number];

export interface DocumentAnalysisSource {
  title: string;
  category: string;
  docDate: string | null;
  /** Sanitized extraction text (buildIndexText output) — never raw text. */
  indexText: string;
}

export interface ParsedInsight {
  kind: InsightKind;
  severity: InsightSeverity;
  title: string;
  body: string;
}

/** Shared with scripts/doc-analysis-compare.ts so the harness runs the prod shape. */
export const DOCUMENT_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    insights: {
      type: "array",
      maxItems: MAX_INSIGHTS,
      items: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: ["red_flag", "grey_zone", "next_step", "deadline_note"],
          },
          severity: { type: "string", enum: ["high", "medium", "low"] },
          title: { type: "string", maxLength: 80 },
          body: { type: "string", maxLength: 600 },
        },
        required: ["kind", "severity", "title", "body"],
        additionalProperties: false,
      },
    },
  },
  required: ["insights"],
  additionalProperties: false,
};

/**
 * XML-escaping for the analysis prompt lives in `src/rag/escape-xml.ts`
 * (shared with the answer pipeline's buildUserMessage). The extraction
 * payload is local-model output over user documents — a literal
 * `</inhalt>`/`</document_extraction>` inside it would otherwise break out
 * of its tag and become model instructions.
 */

export function buildAnalysisPrompt(source: DocumentAnalysisSource): string {
  return [
    "<role>Analyst für deutsche Behördenpost und Verträge. Du arbeitest ausschließlich auf der Seite des Nutzers (Migrant in Deutschland).</role>",
    "<task>Analysiere die extrahierten Dokumentdaten unten und liefere maximal 6 Hinweise in vier Kategorien:",
    "- red_flag: rechtswidrige oder fragwürdige Punkte, drohende Nachteile, versäumte Pflichten der Gegenseite",
    "- grey_zone: doppeldeutige Formulierungen, die zugunsten des Nutzers ausgelegt oder angefochten werden können",
    "- deadline_note: jede Frist mit konkretem Datum und was bis dahin zu tun ist",
    "- next_step: konkrete Handlung in Prioritätsreihenfolge (max. 3)",
    "Antworte auf Deutsch. Titel max. 80 Zeichen, Body 1-2 Sätze. Nur aus dem Extrakt AbleItbares — keine Paragraphen erfinden; wenn kein Paragraph sicher ist, ohne Zitat formulieren.</task>",
    "<document_extraction>",
    `<titel>${escapeXml(source.title)}</titel>`,
    `<kategorie>${escapeXml(source.category)}</kategorie>`,
    `<datum>${escapeXml(source.docDate ?? "unbekannt")}</datum>`,
    `<inhalt>\n${escapeXml(source.indexText)}\n</inhalt>`,
    "</document_extraction>",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Validates the model's JSON reply. `output_config.format` already enforces
 * the schema on a normal completion — this is defense against truncated or
 * otherwise non-conformant edge cases. Unknown kind/severity values are
 * dropped (never persisted blind), empty title/body rows are dropped.
 */
export function parseAnalysisResponse(rawText: string): ParsedInsight[] {
  const parsed: unknown = JSON.parse(rawText);
  if (!isRecord(parsed) || !Array.isArray(parsed.insights)) {
    throw new Error("document analysis response has no insights array");
  }

  const insights: ParsedInsight[] = [];
  for (const item of parsed.insights.slice(0, MAX_INSIGHTS)) {
    if (!isRecord(item)) continue;
    if (
      typeof item.kind !== "string" ||
      !(INSIGHT_KINDS as readonly string[]).includes(item.kind)
    ) {
      continue;
    }
    if (
      typeof item.severity !== "string" ||
      !(INSIGHT_SEVERITIES as readonly string[]).includes(item.severity)
    ) {
      continue;
    }
    const title = typeof item.title === "string" ? item.title.trim() : "";
    const body = typeof item.body === "string" ? item.body.trim() : "";
    if (!title || !body) continue;
    insights.push({
      kind: item.kind as InsightKind,
      severity: item.severity as InsightSeverity,
      title: title.slice(0, 80),
      body: body.slice(0, 600),
    });
  }
  return insights;
}

/**
 * Refused content stays refused: the extraction input is immutable per
 * sourceHash, so a safety refusal is stable and retrying just re-pays
 * Sonnet (~$0.02) through the throttled retry endpoint. Bounded in-memory
 * set of documentIds refused in the last 24h (process-local; a restart
 * re-pays at most once). Capped with FIFO eviction.
 */
const REFUSAL_TTL_MS = 24 * 3600 * 1000;
const REFUSAL_MAX_ENTRIES = 1000;
const recentRefusals = new Map<string, number>();

function wasRecentlyRefused(documentId: string): boolean {
  const at = recentRefusals.get(documentId);
  if (at === undefined) return false;
  if (Date.now() - at > REFUSAL_TTL_MS) {
    recentRefusals.delete(documentId);
    return false;
  }
  return true;
}

function rememberRefusal(documentId: string): void {
  recentRefusals.set(documentId, Date.now());
  // Map preserves insertion order — evict oldest first.
  while (recentRefusals.size > REFUSAL_MAX_ENTRIES) {
    const oldest = recentRefusals.keys().next();
    if (oldest.done) break;
    recentRefusals.delete(oldest.value);
  }
}

/** Test-only reset for the refusal short-circuit (module state). */
export function __testingResetRefusals(): void {
  recentRefusals.clear();
}

/**
 * Server-side document intelligence (step 2 of the document-quality plan).
 *
 * Runs one LLM call over the on-device extraction (the server never sees raw
 * document text) and persists the resulting insights. Computed once per
 * document: the extraction input is immutable for a given sourceHash, so a
 * stored result never goes stale and a retry never pays twice.
 */
@Injectable()
export class DocumentAnalysisService {
  private readonly logger = new Logger(DocumentAnalysisService.name);
  private readonly anthropic: Anthropic;

  constructor(private readonly prisma: PrismaService) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");
    this.anthropic = new Anthropic({ apiKey });
  }

  /**
   * Pure LLM call (no DB) — also used by scripts/doc-analysis-compare.ts for
   * the Sonnet-vs-Haiku side-by-side. Returns [] when the safety classifier
   * refuses (not retryable); throws on API/parse failures.
   */
  async requestAnalysis(
    source: DocumentAnalysisSource,
    model: string = DOCUMENT_ANALYSIS_MODEL,
  ): Promise<ParsedInsight[]> {
    const response = await this.anthropic.messages.create({
      model,
      max_tokens: DOCUMENT_ANALYSIS_MAX_TOKENS,
      system: buildAnalysisPrompt(source),
      messages: [
        {
          role: "user",
          content: `Analysiere dieses Dokument: ${source.title} (${source.category})`,
        },
      ],
      // NOTE: no `temperature` — claude-sonnet-5 rejects the parameter
      // ("temperature is deprecated for this model", verified live). Output
      // stability comes from the enforced JSON schema, not greedy decoding.
      output_config: {
        format: { type: "json_schema", schema: DOCUMENT_ANALYSIS_SCHEMA },
      },
    });
    logLlmUsage(this.logger, "document_analysis", model, response.usage);

    if (response.stop_reason === "refusal") {
      this.logger.warn(
        `Document analysis refused by safety classifier: "${source.title.slice(0, 80)}"`,
      );
      return [];
    }

    // Truncated JSON would fail parseAnalysisResponse anyway, but as an
    // opaque syntax error. Naming the cause here keeps the operator from
    // debugging the schema when the real answer is "max_tokens is too low".
    if (hitOutputBudget(response)) {
      this.logger.warn(
        `Document analysis hit the output-token budget — JSON is truncated: "${source.title.slice(0, 80)}"`,
      );
    }

    const rawText = response.content
      .filter(
        (block): block is Anthropic.TextBlock => block.type === "text",
      )
      .map((block) => block.text)
      .join("");
    if (!rawText) {
      throw new Error(
        `document analysis returned no text (stop_reason=${response.stop_reason ?? "unknown"}, ` +
          `blocks=${response.content.map((block) => block.type).join(",")})`,
      );
    }
    return parseAnalysisResponse(rawText);
  }

  /**
   * Returns stored insights when they exist (no LLM call); otherwise runs
   * the analysis once and persists it. Throws ServiceUnavailableException on
   * API/parse failure — the ingest path treats that as best-effort, the
   * retry endpoint surfaces it.
   */
  async analyzeAndStore(
    userId: string,
    documentId: string,
    sourceHash: string,
    source: DocumentAnalysisSource,
  ): Promise<AppInsightRecord[]> {
    const existing = await this.prisma.documentInsight.findMany({
      where: { userId, documentId },
      orderBy: { createdAt: "asc" },
    });
    if (existing.length > 0) {
      return existing.map(toRecord);
    }
    // Refusals (and genuinely empty analyses) are stable — the extraction
    // input is immutable — so skip the paid call for 24h after an empty
    // result instead of re-paying Sonnet on every manual retry.
    if (wasRecentlyRefused(documentId)) {
      this.logger.log(
        `Document analysis skipped for document ${documentId}: empty result within 24h`,
      );
      return [];
    }

    let parsed: ParsedInsight[];
    try {
      parsed = await this.requestAnalysis(source);
    } catch (err) {
      this.logger.error(
        `Document analysis failed for document ${documentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new ServiceUnavailableException(
        "Document analysis temporarily unavailable",
      );
    }

    if (parsed.length === 0) {
      rememberRefusal(documentId);
      return [];
    }

    // skipDuplicates + @@unique([documentId, kind, title]): the loser of a
    // concurrent double-analyze becomes a reader of the winner's rows
    // below instead of persisting (and billing) a second copy. Composite
    // on purpose: one analysis yields up to MAX_INSIGHTS distinct rows.
    await this.prisma.documentInsight.createMany({
      data: parsed.map((insight) => ({
        userId,
        documentId,
        sourceHash,
        kind: insight.kind,
        severity: insight.severity,
        title: insight.title,
        body: insight.body,
        model: DOCUMENT_ANALYSIS_MODEL,
      })),
      skipDuplicates: true,
    });

    return this.listForDocument(userId, documentId);
  }

  /**
   * Drops the 24h "empty result" memo for one document.
   *
   * The memo assumes the analysis input is immutable for a given document —
   * true while the extraction never changes, false the moment a document is
   * re-extracted. Without this, a rebuild inherits a refusal that describes an
   * extraction that no longer exists and skips the paid call it now needs.
   */
  forgetRefusal(documentId: string): void {
    recentRefusals.delete(documentId);
  }

  async listForDocument(
    userId: string,
    documentId: string,
  ): Promise<AppInsightRecord[]> {
    const rows = await this.prisma.documentInsight.findMany({
      where: { userId, documentId },
      orderBy: { createdAt: "asc" },
    });
    return rows.map(toRecord);
  }

  /**
   * Retry path for `POST /app/v1/documents/:id/analyze`: rebuilds the
   * analysis source from the stored sanitized extraction (`UserDocument.
   * fullText` — the raw document never reaches the server) and analyzes it,
   * unless insights already exist. Failures surface (the caller asked
   * explicitly), unlike the best-effort ingest path.
   */
  async analyzeStoredDocument(
    userId: string,
    documentId: string,
  ): Promise<{ insights: AppInsightRecord[]; cached: boolean }> {
    const doc = await this.prisma.userDocument.findFirst({
      where: { id: documentId, userId },
    });
    if (!doc) {
      throw new BadRequestException("Document not found");
    }

    const existing = await this.listForDocument(userId, doc.id);
    if (existing.length > 0) {
      return { insights: existing, cached: true };
    }

    if (!doc.fullText) {
      throw new BadRequestException(
        "Document has no analyzable extraction",
      );
    }

    const insights = await this.analyzeAndStore(userId, doc.id, doc.sourceHash, {
      title: doc.title ?? doc.fileName ?? doc.id,
      category: doc.category,
      docDate: doc.docDate ? doc.docDate.toISOString().slice(0, 10) : null,
      indexText: doc.fullText,
    });
    return { insights, cached: false };
  }

  async listForUser(
    userId: string,
    documentIds?: string[],
  ): Promise<AppInsightRecord[]> {
    const rows = await this.prisma.documentInsight.findMany({
      where: {
        userId,
        ...(documentIds ? { documentId: { in: documentIds } } : {}),
      },
      orderBy: { createdAt: "asc" },
      // Bound for the uncapped document-list join (sole caller): one
      // analysis yields a handful of insights per document.
      take: 4000,
    });
    return rows.map(toRecord);
  }
}

function toRecord(row: {
  id: string;
  documentId: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  createdAt: Date;
}): AppInsightRecord {
  return {
    id: row.id,
    documentId: row.documentId,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body,
    createdAt: row.createdAt,
  };
}
