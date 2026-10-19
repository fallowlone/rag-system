import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

/**
 * How far ahead a date may sit and still be tracked as a deadline.
 *
 * Was 365 days, which is shorter than the documents this product exists for:
 * a Mietvertrag runs two to three years, an Aufenthaltstitel one to three, and
 * both were dropped — the app path at least reports them as "unusable", the
 * Telegram path dropped them with no trace at all. Five years covers the
 * domain.
 *
 * A longer horizon costs almost nothing in noise: the tracker only notifies
 * inside DEADLINE_DAYS (30), so a 2029 date simply sits in the table until it
 * is a month out. Missing an Aufenthaltstitel expiry is the expensive error.
 *
 * SINGLE SOURCE OF TRUTH — imported by AppDocumentsService (ingest filter) and
 * DocumentQualityService (the user-facing warning). Three independent copies
 * of 365 is how they drifted apart in the first place.
 */
export const MAX_DEADLINE_HORIZON_DAYS = 5 * 365;
const MAX_FUTURE_DAYS = MAX_DEADLINE_HORIZON_DAYS;

/**
 * Cap on one `getUpcomingDeadlines` page. Far above any realistic personal
 * caseload — its purpose is that the callers building Telegram messages and
 * LLM prompts out of this list have an upper bound they can reason about.
 */
const UPCOMING_DEADLINES_MAX = 200;

export const DEADLINE_TERM_TRANSLATIONS: Record<string, string> = {
  Abschlagszahlungstermine: "Платежи по авансу",
  Abschlagszahlung: "Авансовый платёж",
  Widerspruchsfrist: "Срок обжалования",
  "Frist zur Mängelbeseitigung": "Срок устранения недостатков",
  "Frist zur Mangelbeseitigung": "Срок устранения недостатков",
  Mängelbeseitigung: "Устранение недостатков",
  Kündigungsfrist: "Срок уведомления о расторжении",
  Kundigung: "Расторжение договора",
  Kündigung: "Расторжение договора",
  Zahlungsfrist: "Срок оплаты",
  Fälligkeitstermin: "Срок платежа",
  Fälligkeit: "Срок оплаты",
  Ablaufdatum: "Срок действия",
  Vertragslaufzeit: "Срок действия договора",
  Aufenthaltserlaubnis: "Разрешение на проживание",
  Niederlassungserlaubnis: "Бессрочный ВНЖ",
  Aufenthaltstitel: "Вид на жительство",
  Integrationskurs: "Интеграционный курс",
  Eingliederungsvereinbarung: "Соглашение об интеграции",
  Nachfrist: "Дополнительный срок",
  Einspruchsfrist: "Срок подачи возражения",
  Klagefrist: "Срок подачи иска",
  Mietzahlung: "Оплата аренды",
  Mietkaution: "Залог за аренду",
  Nebenkostenabrechnung: "Расчёт коммунальных расходов",
  Jahresabrechnung: "Годовой расчёт",
  Abrechnung: "Расчёт",
  Termin: "Встреча",
  Vermittlungsgespräch: "Встреча по трудоустройству",
  Beratungsgespräch: "Консультация",
};

/**
 * Replace the first matching German legal term in a deadline label with its
 * Russian translation. Pure function — no side effects.
 */
export function translateDeadlineLabel(label: string): string {
  const lowerLabel = label.toLowerCase();
  for (const [term, translation] of Object.entries(
    DEADLINE_TERM_TRANSLATIONS,
  )) {
    if (lowerLabel.includes(term.toLowerCase())) {
      return label.replace(new RegExp(term, "i"), translation);
    }
  }
  return label;
}

export interface DeadlineEntry {
  id: string;
  userId: string;
  label: string;
  deadlineDate: Date;
  sourceType: string;
  sourceId: string | null;
  daysLeft: number;
}

@Injectable()
export class DeadlineService {
  private readonly logger = new Logger(DeadlineService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Extract Date objects from free text using three patterns (regex only, no LLM):
   *   DD.MM.YYYY  e.g. 16.04.2026
   *   DD.MM.YY    e.g. 16.04.26   (century assumed 2000+)
   *   YYYY-MM-DD  e.g. 2026-04-16
   *
   * Skips dates in the past and dates more than 365 days in the future.
   */
  extractDatesFromText(text: string): Date[] {
    return this.extractDateMatchesFromText(text).map(({ date }) => date);
  }

  /**
   * Like extractDatesFromText but also returns the matched string and its
   * position in the original text, so callers can build context-aware labels.
   */
  private extractDateMatchesFromText(
    text: string,
  ): { date: Date; matchStr: string; index: number }[] {
    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
    );
    const farFuture = new Date(now.getTime() + MAX_FUTURE_DAYS * 86400 * 1000);

    const candidates: { date: Date; matchStr: string; index: number }[] = [];

    // DD.MM.YYYY — groups: [1]=DD [2]=MM [3]=YYYY
    for (const m of text.matchAll(/(?<!\d)(\d{2})\.(\d{2})\.(\d{4})(?!\d)/g)) {
      try {
        const d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
        if (!isNaN(d.getTime()))
          candidates.push({ date: d, matchStr: m[0], index: m.index! });
      } catch {
        /* skip malformed */
      }
    }

    // DD.MM.YY — groups: [1]=DD [2]=MM [3]=YY (century 2000+)
    for (const m of text.matchAll(/(?<!\d)(\d{2})\.(\d{2})\.(\d{2})(?!\d)/g)) {
      try {
        const d = new Date(2000 + Number(m[3]), Number(m[2]) - 1, Number(m[1]));
        if (!isNaN(d.getTime()))
          candidates.push({ date: d, matchStr: m[0], index: m.index! });
      } catch {
        /* skip malformed */
      }
    }

    // YYYY-MM-DD — groups: [1]=YYYY [2]=MM [3]=DD
    for (const m of text.matchAll(/(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/g)) {
      try {
        const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
        if (!isNaN(d.getTime()))
          candidates.push({ date: d, matchStr: m[0], index: m.index! });
      } catch {
        /* skip malformed */
      }
    }

    return candidates.filter(
      ({ date }) => date >= todayStart && date <= farFuture,
    );
  }

  /**
   * Extract dates from a memory fact and upsert into UserDeadline.
   * Skips if an identical (userId + deadlineDate calendar day + sourceId) row already exists.
   * Returns false when any per-date write failed (the startup backfill
   * withholds its completion marker then, instead of losing deadlines
   * silently). Per-item failures are still logged, never thrown — the
   * real-time callers fire-and-forget this method.
   */
  async saveDeadlinesFromMemory(
    userId: string,
    memoryId: string,
    content: string,
    /**
     * The document this memory was extracted from, when there is one.
     *
     * Two writers create deadlines for one document: the structured
     * `deadlines[]` the local model produced (sourceId = documentId) and this
     * regex pass over each fact's text (sourceId = memoryId). The dedup below
     * was keyed on sourceId alone, so it never matched across them and a
     * Widerspruchsfrist that appeared in both produced TWO rows — two
     * reminders at 09:00, two entries in /status and the calendar, and
     * completing one left the other open. Passing the document in lets the
     * check see the structured row that already covers this day.
     */
    documentId?: string,
  ): Promise<boolean> {
    const matches = this.extractDateMatchesFromText(content);
    if (matches.length === 0) return true;

    let ok = true;
    for (const { date, matchStr, index } of matches) {
      const label = buildDeadlineLabel(content, matchStr, index);
      try {
        const dayStart = new Date(
          date.getFullYear(),
          date.getMonth(),
          date.getDate(),
        );
        const dayEnd = new Date(dayStart.getTime() + 86400 * 1000);

        const existing = await this.prisma.userDeadline.findFirst({
          where: {
            userId,
            deadlineDate: { gte: dayStart, lt: dayEnd },
            // Same memory (idempotent re-run) OR the owning document's own
            // structured row for that day. Deliberately not "any row on that
            // day": two unrelated documents may genuinely share a deadline
            // date and both deserve their reminder.
            OR: documentId
              ? [{ sourceId: memoryId }, { sourceId: documentId }]
              : [{ sourceId: memoryId }],
          },
          select: { id: true },
        });

        if (!existing) {
          await this.prisma.userDeadline.create({
            data: {
              userId,
              label,
              deadlineDate: date,
              sourceType: "memory",
              sourceId: memoryId,
            },
          });
        }
      } catch (err) {
        ok = false;
        this.logger.warn(
          `saveDeadlinesFromMemory failed for memory ${memoryId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return ok;
  }

  /**
   * Insert a document expiry date into UserDeadline.
   * Skips if an identical (userId + same calendar day + sourceId) row already exists.
   * Same boolean contract as saveDeadlinesFromMemory (see above).
   */
  async saveDeadlinesFromDocument(
    userId: string,
    documentId: string,
    expiryDate: Date,
    label: string | null | undefined,
  ): Promise<boolean> {
    try {
      const dayStart = new Date(
        expiryDate.getFullYear(),
        expiryDate.getMonth(),
        expiryDate.getDate(),
      );
      const dayEnd = new Date(dayStart.getTime() + 86400 * 1000);

      const existing = await this.prisma.userDeadline.findFirst({
        where: {
          userId,
          sourceId: documentId,
          deadlineDate: { gte: dayStart, lt: dayEnd },
        },
        select: { id: true },
      });

      if (!existing) {
        await this.prisma.userDeadline.create({
          data: {
            userId,
            label: label ?? "Dokument",
            deadlineDate: expiryDate,
            sourceType: "document",
            sourceId: documentId,
          },
        });
      }
    } catch (err) {
      this.logger.warn(
        `saveDeadlinesFromDocument failed for document ${documentId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
    return true;
  }

  /**
   * Marks a deadline done (completed=true) or reopens it. Owner-scoped via
   * updateMany — a foreign id reads as false, never as a cross-user write.
   */
  async setDeadlineCompleted(
    userId: string,
    deadlineId: string,
    completed: boolean,
  ): Promise<boolean> {
    const result = await this.prisma.userDeadline.updateMany({
      where: { id: deadlineId, userId },
      data: { completedAt: completed ? new Date() : null },
    });
    return result.count > 0;
  }

  /**
   * Fetch deadlines for a user within the next `withinDays` days, sorted asc.
   * Returns a plain object with `daysLeft` computed.
   */
  async getUpcomingDeadlines(
    userId: string,
    withinDays: number,
  ): Promise<DeadlineEntry[]> {
    const now = new Date();
    const cutoff = new Date(now.getTime() + withinDays * 86400 * 1000);

    const rows = await this.prisma.userDeadline.findMany({
      where: {
        userId,
        // Completed deadlines stay in history but must not resurface in the
        // morning tracker or the Telegram upcoming list.
        completedAt: null,
        deadlineDate: { gte: now, lte: cutoff },
      },
      orderBy: { deadlineDate: "asc" },
      // Bounded at the source, not just where it is rendered: the window
      // keeps this small in practice, but "in practice" is not a bound, and
      // every caller here builds a message or a prompt out of the result.
      take: UPCOMING_DEADLINES_MAX,
    });
    if (rows.length === UPCOMING_DEADLINES_MAX) {
      this.logger.warn(
        `Upcoming deadlines for user ${userId} hit the ${UPCOMING_DEADLINES_MAX}-row cap — furthest-out entries omitted`,
      );
    }

    return rows.map((r) => ({
      id: r.id,
      userId: r.userId,
      label: r.label,
      deadlineDate: r.deadlineDate,
      sourceType: r.sourceType,
      sourceId: r.sourceId,
      daysLeft: Math.ceil(
        (r.deadlineDate.getTime() - now.getTime()) / (86400 * 1000),
      ),
    }));
  }

  /** Remove all deadlines linked to a given sourceId (memory or document deleted), scoped to userId. */
  /**
   * Deletes all deadlines carrying a source marker. Failures are logged AND
   * rethrown: swallowing them orphans UserDeadline rows whose 09:00 tracker
   * notifications keep firing for deleted documents/memories — strictly
   * worse than a retried 500. All callers run this before the parent-row
   * delete (idempotent), so any failure leaves retryable state.
   */
  async deleteDeadlinesBySource(sourceId: string, userId: string): Promise<void> {
    try {
      await this.prisma.userDeadline.deleteMany({ where: { sourceId, userId } });
    } catch (err) {
      this.logger.warn(
        `deleteDeadlinesBySource failed for source ${sourceId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }
}

/**
 * Build a deadline label from context surrounding the matched date string.
 * Takes up to 40 chars before the date, strips leading/trailing whitespace and
 * punctuation, and formats as "{prefix}: {dateStr}".
 * Falls back to the first 60 chars of content when no useful prefix is found.
 */
function buildDeadlineLabel(
  content: string,
  matchStr: string,
  index: number,
): string {
  const prefixRaw = content.slice(Math.max(0, index - 40), index);
  const prefix = prefixRaw
    .replace(/^[\s[\](){}.,;:!?«»–—'"]+/, "")
    .replace(/[\s[\](){}.,;:!?«»–—'"]+$/, "");
  if (prefix.length >= 5) {
    return `${prefix}: ${matchStr}`;
  }
  return content.length > 60 ? content.slice(0, 60) + "…" : content;
}
