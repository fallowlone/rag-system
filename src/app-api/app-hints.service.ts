import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AppHint } from "./app-api.types";
import { utcStartOfToday } from "./iso-date";

/**
 * Categories whose issuers act as authorities (Verwaltungsakt): their
 * letters carry a one-month Widerspruchsfrist. Private-law categories
 * (mietvertrag, bank, versicherung) and unknown ones are excluded — flagging
 * a Widerspruch deadline there would be legally wrong noise.
 */
const WIDERSPRUCH_CATEGORIES = ["jobcenter", "visa"];

/** Sliding window for "several deadlines at once" clustering. */
const CLUSTER_WINDOW_DAYS = 3;

// Bounds for the hint queries. Generous against realistic personal volume;
// they exist so the cost of this endpoint tracks what the hints can report on
// rather than the account's whole history.
const HINTS_MAX_DOCUMENTS = 500;
const HINTS_MAX_DEADLINES = 500;
const HINTS_MAX_INSIGHTS = 4000;

interface HintDocument {
  id: string;
  fileName: string | null;
  title: string | null;
  category: string;
  isActive: boolean;
  docDate: Date | null;
  expiryDate: Date | null;
  appSource: boolean;
}

interface HintDeadline {
  label: string;
  deadlineDate: Date;
  completedAt: Date | null;
  sourceId: string | null;
}

function displayName(doc: Pick<HintDocument, "title" | "fileName">): string {
  return doc.title ?? doc.fileName ?? "Dokument";
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Proactive cross-document hints (step 4 of the document-quality plan).
 *
 * Deterministic, no LLM, no new tables: computed on demand from the rows the
 * ingest path already maintains. Deliberately covers only what the daily
 * 09:00 deadline tracker does NOT — the tracker fires on extracted deadline
 * rows, so it can never warn about a deadline that was never extracted
 * (missing Widerspruch), a stale active flag, several deadlines colliding in
 * one week, or a document whose analysis never ran.
 */
@Injectable()
export class AppHintsService {
  private readonly logger = new Logger(AppHintsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async hints(userId: string, now: Date = new Date()): Promise<AppHint[]> {
    const startOfToday = utcStartOfToday(now);

    // Every query here is bounded, and the deadline/insight legs are scoped to
    // the documents actually in scope rather than to the user's whole history.
    // Previously all three were unbounded `where: { userId }` scans on a path
    // that runs on every hints request, so cost grew with the account's
    // lifetime rather than with what the hints can actually report on.
    const docs = await this.prisma.userDocument.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: HINTS_MAX_DOCUMENTS,
      select: {
        id: true,
        fileName: true,
        title: true,
        category: true,
        isActive: true,
        docDate: true,
        expiryDate: true,
        appSource: true,
      },
    });
    if (docs.length === HINTS_MAX_DOCUMENTS) {
      this.logger.warn(
        `Hints for user ${userId} hit the ${HINTS_MAX_DOCUMENTS}-document cap — oldest documents not considered`,
      );
    }
    const documentIds = docs.map((doc) => doc.id);

    const [deadlinesForDocs, openDeadlines, insightRows] = await Promise.all([
      // Only "does this document have ANY deadline row" — the date does not
      // matter, so this cannot be filtered by date (a document whose only
      // deadline is in the past must not read as "deadline missing").
      documentIds.length > 0
        ? this.prisma.userDeadline.findMany({
            where: { userId, sourceId: { in: documentIds } },
            select: { sourceId: true },
            take: HINTS_MAX_DEADLINES,
          })
        : Promise.resolve([]),
      // Clusters only ever look at open future deadlines, so the query says so
      // instead of filtering a full-history result in memory.
      this.prisma.userDeadline.findMany({
        where: {
          userId,
          completedAt: null,
          deadlineDate: { gte: startOfToday },
        },
        orderBy: { deadlineDate: "asc" },
        take: HINTS_MAX_DEADLINES,
        select: {
          label: true,
          deadlineDate: true,
          completedAt: true,
          sourceId: true,
        },
      }),
      documentIds.length > 0
        ? this.prisma.documentInsight.findMany({
            where: { userId, documentId: { in: documentIds } },
            select: { documentId: true },
            take: HINTS_MAX_INSIGHTS,
          })
        : Promise.resolve([]),
    ]);

    const docIdsWithDeadlines = new Set(
      deadlinesForDocs
        .map((d) => d.sourceId)
        .filter((id): id is string => id !== null),
    );

    const result: AppHint[] = [];
    result.push(
      ...this.widerspruchHints(docs, docIdsWithDeadlines, startOfToday),
      ...this.expiredHints(docs, startOfToday),
      ...this.clusterHints(openDeadlines, startOfToday),
      ...this.missingAnalysisHints(docs, insightRows),
    );
    return result;
  }

  /**
   * Authority letter with a document date but no deadline row at all: the
   * local model likely missed the Widerspruchsfrist (one month after
   * Bekanntgabe, approximated here as docDate + 1 month).
   */
  private widerspruchHints(
    docs: HintDocument[],
    docIdsWithDeadlines: ReadonlySet<string>,
    startOfToday: Date,
  ): AppHint[] {
    const hints: AppHint[] = [];
    for (const doc of docs) {
      if (!doc.isActive) continue;
      if (!WIDERSPRUCH_CATEGORIES.includes(doc.category)) continue;
      if (!doc.docDate) continue;
      if (docIdsWithDeadlines.has(doc.id)) continue;

      // Calendar-day arithmetic in UTC: deadline dates are days, not
      // instants — local-timezone construction would shift the ISO day.
      // Clamp to the target month's last day: Jan 31 + 1 month is Feb 28/29,
      // not Mar 3 (Date.UTC normalizes overflowing days into March).
      const targetYear = doc.docDate.getUTCFullYear();
      const targetMonth = doc.docDate.getUTCMonth();
      const lastDayOfTarget = new Date(
        Date.UTC(targetYear, targetMonth + 2, 0),
      ).getUTCDate();
      const frist = new Date(
        Date.UTC(
          targetYear,
          targetMonth + 1,
          Math.min(doc.docDate.getUTCDate(), lastDayOfTarget),
        ),
      );
      const past = frist < startOfToday;
      hints.push({
        kind: "missing_widerspruch_deadline",
        severity: "high",
        documentIds: [doc.id],
        title: past
          ? `Widerspruchsfrist für „${displayName(doc)}“ möglicherweise verstrichen`
          : `Widerspruchsfrist für „${displayName(doc)}“ prüfen`,
        body: past
          ? `Dokumentdatum ${isoDay(doc.docDate)} — die Monatsfrist wäre etwa am ${isoDay(frist)} abgelaufen. Sofort prüfen, ob noch ein Rechtsmittel möglich ist.`
          : `Dokumentdatum ${isoDay(doc.docDate)} — die Widerspruchsfrist läuft etwa am ${isoDay(frist)} ab, steht aber in keiner extrahierten Frist. Datum im Dokument prüfen.`,
      });
    }
    return hints;
  }

  private expiredHints(
    docs: HintDocument[],
    startOfToday: Date,
  ): AppHint[] {
    return docs
      .filter(
        (doc) =>
          doc.isActive && doc.expiryDate !== null && doc.expiryDate < startOfToday,
      )
      .map((doc) => ({
        kind: "expired_still_active" as const,
        severity: "medium" as const,
        documentIds: [doc.id],
        title: `„${displayName(doc)}“ ist abgelaufen, aber noch als aktiv markiert`,
        body: `Gültig bis ${isoDay(doc.expiryDate as Date)} — als erledigt markieren oder Nachfolgedokument prüfen.`,
      }));
  }

  /**
   * Two or more open future deadlines colliding: each fires separately in
   * the tracker, but the collision itself is the actionable insight (plan
   * the week, not the day). Clusters are maximal chains linked by gaps of at
   * most CLUSTER_WINDOW_DAYS — a disjoint sliding window would silently drop
   * the B–C collision in an A=day0,B=day2,C=day4 chain after consuming {A,B}.
   */
  private clusterHints(
    deadlines: HintDeadline[],
    startOfToday: Date,
  ): AppHint[] {
    const open = deadlines
      .filter((d) => d.completedAt === null && d.deadlineDate >= startOfToday)
      .sort((a, b) => a.deadlineDate.getTime() - b.deadlineDate.getTime());

    const windowMs = CLUSTER_WINDOW_DAYS * 86400_000;
    const clusters: HintDeadline[][] = [];
    let current: HintDeadline[] = [];
    for (const deadline of open) {
      const prev = current[current.length - 1];
      if (
        prev &&
        deadline.deadlineDate.getTime() - prev.deadlineDate.getTime() >
          windowMs
      ) {
        if (current.length >= 2) clusters.push(current);
        current = [];
      }
      current.push(deadline);
    }
    if (current.length >= 2) clusters.push(current);

    return clusters.map((group) => {
      const first = group[0]!;
      const last = group[group.length - 1]!;
      // Link the colliding deadlines' documents so clients (Fristen-Radar)
      // can badge the exact rows. Manual deadlines carry no sourceId and
      // simply don't link.
      const documentIds = [
        ...new Set(
          group
            .map((d) => d.sourceId)
            .filter((id): id is string => id !== null),
        ),
      ];
      return {
        kind: "deadline_cluster" as const,
        severity: "medium" as const,
        documentIds,
        title: `${group.length} Fristen zwischen ${isoDay(first.deadlineDate)} und ${isoDay(last.deadlineDate)}`,
        body: group.map((d) => `• ${d.label} (${isoDay(d.deadlineDate)})`).join("\n"),
      };
    });
  }

  /**
   * One aggregated hint for app documents whose LLM analysis never ran
   * (failed/refused at ingest). Telegram-path documents are excluded — they
   * carry no analyzable extraction.
   */
  private missingAnalysisHints(
    docs: HintDocument[],
    insightRows: { documentId: string }[],
  ): AppHint[] {
    const analyzed = new Set(insightRows.map((row) => row.documentId));
    const missing = docs.filter(
      (doc) => doc.appSource && !analyzed.has(doc.id),
    );
    if (missing.length === 0) return [];
    const first = missing[0];
    return [
      {
        kind: "analysis_missing",
        severity: "low",
        documentIds: missing.map((doc) => doc.id),
        title:
          missing.length === 1 && first
            ? `Analyse für „${displayName(first)}“ fehlt`
            : `Analyse für ${missing.length} Dokumente fehlt`,
        body: "Über „Analysieren“ nachholen, um Warnhinweise und nächste Schritte zu erhalten.",
      },
    ];
  }
}
