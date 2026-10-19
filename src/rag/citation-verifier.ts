import { Injectable, Logger } from "@nestjs/common";
import { LAW_ABBREVIATIONS } from "./retrieval.service";
import { ChunkSearchResult } from "./rag.types";

/**
 * Citation verification (Task 16): after an answer is generated, extract all
 * legal citations ("§ 573 BGB", "§§ 535, 536 BGB", "Art. 6 GG") from the
 * answer text and check them against the (lawId, § number) set of the chunks
 * that were actually passed into the prompt. Citations that were never
 * retrieved are likely hallucinated and get a structured WARN log.
 *
 * Pure functions do the work; the thin injectable service owns the logger.
 * Verification is a post-send step — it must never block or fail the answer.
 */

/** `573`, `573a` — the number+suffix part of a § citation. */
const PARA_NUM = String.raw`\d+[a-z]{0,2}`;

/**
 * Separators inside a §§-list: "§§ 535, 536 BGB", "§§ 573 und 574 BGB",
 * "§§ 573 bis 575 BGB" (range endpoints only — intermediates not enumerated),
 * optionally repeating the § sign ("§ 535 und § 536 BGB").
 */
const PARA_LIST = String.raw`${PARA_NUM}(?:\s*(?:,|und|oder|bis|[-–])\s*(?:§\s*)?${PARA_NUM})*`;

/**
 * Subdivision tokens between the § number and the law name — ignored for
 * matching per Task 16: "Abs. 2", "Absatz 1", "Satz 3", "Nr. 5".
 */
const SUBDIVISION = String.raw`(?:\s*(?:Abs\.?|Absatz)\s*\d+[a-z]?|\s*(?:S\.|Satz)\s*\d+|\s*(?:Nr\.?|Nummer)\s*\d+)`;

/**
 * The law name token following the citation: "BGB", "AufenthG", "SGB II",
 * "SGB XII", "GG". A capitalized word with an optional roman-numeral suffix.
 */
const LAW_TOKEN = String.raw`[A-ZÄÖÜ][A-Za-zÄÖÜäöüß]*(?:\s+[IVX]{1,4}\b)?`;

const SECTION_RE = new RegExp(
  String.raw`§§?\s*(${PARA_LIST})${SUBDIVISION}*\s+(${LAW_TOKEN})`,
  "g",
);

/** "Art. 6 GG", "Artikel 6 Abs. 1 GG" — Grundgesetz cites articles, not §§. */
const ARTICLE_RE = new RegExp(
  String.raw`\bArt(?:ikel|\.)\s*(${PARA_LIST})${SUBDIVISION}*\s+(${LAW_TOKEN})`,
  "g",
);

export interface ExtractedCitation {
  /** The full matched citation text as it appeared in the answer. */
  raw: string;
  /** "§" or "Art." */
  kind: "§" | "Art.";
  /** Lowercased paragraph numbers, e.g. ["535", "536"] for a §§-list. */
  paragraphs: string[];
  /** The law name token as written, e.g. "SGB II". */
  lawToken: string;
  /** Normalized DB lawId via LAW_ABBREVIATIONS, or null if unknown. */
  lawId: string | null;
}

export interface CitationCheck {
  /** Normalized single-paragraph citation, e.g. "§ 536 BGB". */
  citation: string;
  lawId: string | null;
  paragraph: string;
}

export interface CitationVerificationResult {
  /** Individual (paragraph, law) pairs checked (a §§-list counts per §). */
  total: number;
  matched: CitationCheck[];
  /** Known law, but the § was NOT among the retrieved chunks — suspect. */
  unmatched: CitationCheck[];
  /** Law not in LAW_ABBREVIATIONS (e.g. GG) — unverifiable, not flagged. */
  unknownLaw: CitationCheck[];
  /** "lawId:§number" keys of the law chunks that were in the prompt. */
  retrievedKeys: string[];
}

/**
 * Normalizes a law name token from the answer text to its DB lawId using the
 * shared LAW_ABBREVIATIONS map from retrieval.service. Returns null for laws
 * not in the database (e.g. GG) — those cannot be verified against chunks.
 */
export function normalizeLawToken(token: string): string | null {
  for (const { pattern, lawId } of LAW_ABBREVIATIONS) {
    if (pattern.test(token)) return lawId;
  }
  return null;
}

/** Extracts all § / Art. citations with a recognizable law name suffix. */
export function extractCitations(text: string): ExtractedCitation[] {
  const citations: ExtractedCitation[] = [];
  for (const [re, kind] of [
    [SECTION_RE, "§"],
    [ARTICLE_RE, "Art."],
  ] as const) {
    for (const m of text.matchAll(re)) {
      const [raw, list, lawToken] = m;
      if (!list || !lawToken) continue;
      const paragraphs = (
        list.toLowerCase().match(new RegExp(PARA_NUM, "g")) ?? []
      ).map((p) => p.trim());
      if (paragraphs.length === 0) continue;
      citations.push({
        raw,
        kind,
        paragraphs,
        lawToken: lawToken.trim(),
        lawId: normalizeLawToken(lawToken),
      });
    }
  }
  return citations;
}

/**
 * Builds the set of "lawId:§number" keys actually passed into the prompt.
 * Docvault chunks are personal documents, not laws — excluded. The paragraph
 * number is pulled from the normKey ("§ 573_p2_c1" → "573"); the first
 * number always belongs to the §, the `_pN_cN` chunk-split suffix comes after.
 */
export function buildRetrievedKeys(chunks: ChunkSearchResult[]): Set<string> {
  const keys = new Set<string>();
  for (const chunk of chunks) {
    if (chunk.lawId === "docvault") continue;
    const num = /(\d+[a-z]{0,2})/.exec(chunk.normKey)?.[1]?.toLowerCase();
    if (num) keys.add(`${chunk.lawId}:${num}`);
  }
  return keys;
}

/**
 * Verifies every citation extracted from the answer against the retrieved
 * chunk set. Pure and synchronous — safe to call after the answer was sent.
 */
export function verifyCitations(
  answerText: string,
  chunks: ChunkSearchResult[],
): CitationVerificationResult {
  const retrieved = buildRetrievedKeys(chunks);
  const matched: CitationCheck[] = [];
  const unmatched: CitationCheck[] = [];
  const unknownLaw: CitationCheck[] = [];

  for (const citation of extractCitations(answerText)) {
    for (const paragraph of citation.paragraphs) {
      const check: CitationCheck = {
        citation: `${citation.kind} ${paragraph} ${citation.lawToken}`,
        lawId: citation.lawId,
        paragraph,
      };
      if (citation.lawId === null) {
        unknownLaw.push(check);
      } else if (retrieved.has(`${citation.lawId}:${paragraph}`)) {
        matched.push(check);
      } else {
        unmatched.push(check);
      }
    }
  }

  return {
    total: matched.length + unmatched.length + unknownLaw.length,
    matched,
    unmatched,
    unknownLaw,
    retrievedKeys: [...retrieved],
  };
}

@Injectable()
export class CitationVerifierService {
  private readonly logger = new Logger(CitationVerifierService.name);

  /**
   * Fire-and-forget verification: never throws, never blocks the answer
   * path. Unverified citations (known law, § not among retrieved chunks)
   * produce one structured WARN with userId, citations and retrieved set.
   * No user-facing disclaimer is added (Task 16 — log + counter only).
   */
  verifyAndLog(
    answerText: string,
    chunks: ChunkSearchResult[],
    userId?: string,
  ): CitationVerificationResult | null {
    try {
      const result = verifyCitations(answerText, chunks);
      if (result.unmatched.length > 0) {
        this.logger.warn(
          `[citation-verify] unverified citations ${JSON.stringify({
            userId: userId ?? null,
            unmatched: result.unmatched.map((c) => c.citation),
            unknownLaw: result.unknownLaw.map((c) => c.citation),
            retrieved: result.retrievedKeys,
            totalCitations: result.total,
            matchedCount: result.matched.length,
            unmatchedCount: result.unmatched.length,
          })}`,
        );
      } else if (result.total > 0) {
        this.logger.debug(
          `[citation-verify] ok: ${result.matched.length}/${result.total} matched, ${result.unknownLaw.length} unverifiable (unknown law)`,
        );
      }
      return result;
    } catch (err) {
      // Verification must never break the answer flow.
      this.logger.warn(
        `[citation-verify] verification failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }
}
