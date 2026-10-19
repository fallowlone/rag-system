import { Injectable } from "@nestjs/common";
import {
  AppDocumentIngestInput,
  DocumentQualityIssue,
  DocumentQualityReport,
} from "./app-api.types";
import { DocumentCategory } from "../memory/memory.types";
import { utcStartOfToday } from "./iso-date";
import { MAX_DEADLINE_HORIZON_DAYS } from "../deadlines/deadline.service";

type Severity = DocumentQualityIssue["severity"];

const SCORE_PENALTY: Record<Severity, number> = {
  high: 25,
  medium: 10,
  low: 5,
};

/**
 * Per-category fields the on-device model is expected to extract. A document
 * that carries none of its category's typical signals (amounts, deadlines,
 * expiry/doc dates) usually means the local extraction missed content — not
 * that the document has none (a Jobcenter-Bescheid without a single amount
 * or a Widerspruch deadline is implausible).
 */
const CATEGORY_EXPECTATIONS: Partial<
  Record<DocumentCategory, Array<"amounts" | "deadlines" | "dates">>
> = {
  jobcenter: ["amounts", "deadlines"],
  mietvertrag: ["amounts", "dates"],
  bank: ["amounts"],
  visa: ["dates", "deadlines"],
  versicherung: ["amounts", "dates"],
};

function issue(
  code: string,
  severity: Severity,
  message: string,
): DocumentQualityIssue {
  return { code, severity, message };
}

/**
 * Deterministic quality gate for on-device document extractions.
 *
 * Pure function of the ingest payload (no DB, no LLM, no network): it flags
 * what the local model most likely missed — empty facts, absent summaries,
 * category-atypical payloads (e.g. a Jobcenter letter with neither amounts
 * nor deadlines), unusable deadline dates, and duplicate facts. The app
 * surfaces the issues as "bitte prüfe diese Felder" right after ingest.
 */
@Injectable()
export class DocumentQualityService {
  assess(
    input: AppDocumentIngestInput,
    now: Date = new Date(),
  ): DocumentQualityReport {
    const issues: DocumentQualityIssue[] = [];

    if (!input.summary) {
      issues.push(
        issue(
          "missing_summary",
          "medium",
          "Keine Zusammenfassung extrahiert — bitte prüfen, ob das Dokument lesbar war.",
        ),
      );
    }

    if (input.facts.length === 0) {
      issues.push(
        issue(
          "no_facts",
          "high",
          "Keine Fakten extrahiert — das Dokument wurde möglicherweise nicht erkannt.",
        ),
      );
    }

    if (!input.docDate && !input.expiryDate) {
      issues.push(
        issue(
          "no_dates",
          "low",
          "Kein Dokumentdatum gefunden — Fristen lassen sich ohne Datum schwer berechnen.",
        ),
      );
    }

    const expectations = CATEGORY_EXPECTATIONS[input.category];
    if (expectations && input.facts.length > 0) {
      const hasAmounts = input.amounts.length > 0;
      const hasDeadlines = input.deadlines.length > 0;
      const hasDates = Boolean(input.docDate ?? input.expiryDate);
      const signals = { amounts: hasAmounts, deadlines: hasDeadlines, dates: hasDates };
      const missing = expectations.filter((key) => !signals[key]);
      if (missing.length === expectations.length) {
        issues.push(
          issue(
            "category_fields_missing",
            "high",
            `Für Kategorie ${input.category} typische Angaben fehlen (${missing.join(", ")}) — bitte Extraktion prüfen.`,
          ),
        );
      }
    }

    const startOfToday = utcStartOfToday(now);
    const maxDate = new Date(startOfToday);
    // Same horizon the ingest filter applies — imported so the warning can
    // never describe a rule the storage path no longer follows.
    maxDate.setUTCDate(maxDate.getUTCDate() + MAX_DEADLINE_HORIZON_DAYS);
    const isUsableDeadline = (dateStr: string): boolean => {
      const date = new Date(`${dateStr}T00:00:00.000Z`);
      return (
        !Number.isNaN(date.getTime()) && date >= startOfToday && date <= maxDate
      );
    };
    const unusableDeadlines = input.deadlines.filter(
      (d) => !isUsableDeadline(d.date),
    );
    if (unusableDeadlines.length > 0) {
      issues.push(
        issue(
          "unusable_deadlines",
          "medium",
          `${unusableDeadlines.length} Frist(en) liegen in der Vergangenheit oder weiter als ${MAX_DEADLINE_HORIZON_DAYS} Tage voraus und wurden ignoriert.`,
        ),
      );
    }

    const seen = new Set<string>();
    const duplicates = input.facts.filter((f) => {
      const normalized = f.content.trim().toLowerCase();
      if (seen.has(normalized)) return true;
      seen.add(normalized);
      return false;
    });
    if (duplicates.length > 0) {
      issues.push(
        issue(
          "duplicate_facts",
          "low",
          `${duplicates.length} doppelte Fakten gefunden — möglicherweise doppelt extrahiert.`,
        ),
      );
    }

    // Usable count, not raw count: obligations plus only past/>365-day
    // deadlines (which ingest filters out) still leave zero storable
    // deadlines and must warn.
    if (
      input.obligations.length > 0 &&
      !input.deadlines.some((d) => isUsableDeadline(d.date))
    ) {
      issues.push(
        issue(
          "obligations_without_deadlines",
          "low",
          "Pflichten ohne Fristen gefunden — bitte prüfen, ob eine Frist im Dokument steht.",
        ),
      );
    }

    const score = Math.max(
      0,
      100 - issues.reduce((sum, i) => sum + SCORE_PENALTY[i.severity], 0),
    );

    return { score, issues };
  }
}
