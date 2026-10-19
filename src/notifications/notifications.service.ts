import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { CacheService } from "../cache/cache.service";
import {
  TelegramService,
  escapeHtml,
  splitByChars,
} from "../telegram/telegram.service";
import {
  DeadlineService,
  DeadlineEntry,
  translateDeadlineLabel,
} from "../deadlines/deadline.service";
import { getAllowedTelegramIds } from "../config/allowed-users";
import { UserMemoryService } from "../memory/user-memory.service";
import { UserLang } from "../memory/memory.types";

const DEADLINE_DAYS = 30;
const DEADLINE_SECTION_DAYS = 90;
const HEALTH_ALERT_KEY = "health:last_alert_sent";
const HEALTH_ALERT_TTL = 600; // 10 minutes
// Marks a user's one-time deadline backfill as fully completed. Stored as a
// UserMemory preference (same pattern as the "language:" marker) rather than
// inferred from `UserDeadline` row count — a partial backfill (crash after
// some facts/docs but before others) previously left rows behind, which made
// the row-count guard treat the whole backfill as done and permanently skip
// the rest.
const DEADLINE_BACKFILL_MARKER = "deadline_backfill:done";
// Single-flight across replicas (mirrors ConflictPushService): two app
// instances must not both run the 09:00 tracker (double reminders).
const DEADLINE_TRACKER_LOCK_SECONDS = 600;

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly telegram: TelegramService,
    private readonly deadlines: DeadlineService,
    private readonly userMemory: UserMemoryService,
  ) {}

  // ── Startup backfill ───────────────────────────────────────────────────────

  /**
   * One-time backfill per allowed user: if UserDeadline is empty for that user,
   * scan their UserMemory facts + UserDocument expiry dates and populate the
   * deadline table. Runs independently per user; one user's failure does not
   * block others.
   */
  async onModuleInit(): Promise<void> {
    const allowedIds = getAllowedTelegramIds();
    if (allowedIds.length === 0) return;

    // Concurrent per user — one user's slow/failed backfill must not delay
    // or block the others behind a serial loop.
    await Promise.all(
      allowedIds.map(async (userId) => {
        try {
          await this.backfillDeadlinesForUser(userId);
        } catch (err) {
          this.logger.warn(
            `Deadline backfill failed for user ${userId}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }),
    );
  }

  private async backfillDeadlinesForUser(userId: string): Promise<void> {
    const marker = await this.prisma.userMemory.findFirst({
      where: { userId, type: "preference", content: DEADLINE_BACKFILL_MARKER },
      select: { id: true },
    });
    if (marker) {
      this.logger.log(`Deadline backfill (${userId}): already completed — skipping`);
      return;
    }

    const facts = await this.prisma.userMemory.findMany({
      where: { userId, type: { in: ["fact", "document"] } },
      select: { id: true, content: true },
    });

    // Facts are independent rows — parse them concurrently instead of one
    // serial round trip per fact.
    const memoryResults = await Promise.all(
      facts.map((fact) =>
        this.deadlines.saveDeadlinesFromMemory(userId, fact.id, fact.content),
      ),
    );

    const docs = await this.prisma.userDocument.findMany({
      where: { userId, expiryDate: { not: null } },
      select: { id: true, fileName: true, expiryDate: true },
    });
    const docResults = await Promise.all(
      docs.map((doc) =>
        this.deadlines.saveDeadlinesFromDocument(
          userId,
          doc.id,
          doc.expiryDate!,
          doc.fileName,
        ),
      ),
    );

    // The save methods report per-item failures as false (never throw), so
    // gate the marker on them: persisting "done" over a partial backfill
    // would lose deadlines silently with no retry on next restart.
    const failed = [...memoryResults, ...docResults].filter((ok) => !ok).length;
    if (failed > 0) {
      this.logger.warn(
        `Deadline backfill (${userId}): ${failed} save(s) failed — marker withheld, will retry next restart`,
      );
      return;
    }

    // Plain row write, NOT userMemory.remember(): remember() embeds the
    // content (a wasted embedding call for a fixed marker string) and
    // fire-and-forgets deadline extraction on it.
    await this.prisma.userMemory.create({
      data: { userId, type: "preference", content: DEADLINE_BACKFILL_MARKER },
    });

    this.logger.log(
      `Deadline backfill (${userId}): scanned ${facts.length} facts, ${docs.length} documents — marked complete`,
    );
  }

  // ── Feature 1: Daily deadline tracker ──────────────────────────────────────

  /** Runs every day at 09:00 Europe/Berlin time, once per allowed user. */
  @Cron("0 9 * * *", { timeZone: "Europe/Berlin" })
  async runDeadlineTracker(): Promise<void> {
    const owned = await this.cache.setJsonNx(
      "cronlock:deadline-tracker",
      { at: new Date().toISOString() },
      DEADLINE_TRACKER_LOCK_SECONDS,
    );
    if (!owned) {
      this.logger.log("Deadline tracker skipped: owned by another replica");
      return;
    }
    const start = Date.now();
    this.logger.log("Deadline tracker started");

    const allowedIds = getAllowedTelegramIds();
    if (allowedIds.length === 0) {
      this.logger.warn(
        "No allowed Telegram IDs configured — skipping deadline tracker",
      );
      return;
    }

    let totalSent = 0;
    for (const userId of allowedIds) {
      try {
        const sent = await this.runDeadlineTrackerForUser(userId);
        totalSent += sent;
      } catch (err) {
        this.logger.error(
          `Deadline tracker failed for user ${userId}`,
          err instanceof Error ? err.stack : String(err),
        );
      }
    }

    this.logger.log(
      `Deadline tracker: sent ${totalSent} reminder(s) across ${allowedIds.length} user(s) in ${Date.now() - start}ms`,
    );
  }

  private async runDeadlineTrackerForUser(userId: string): Promise<number> {
    const upcoming = await this.deadlines.getUpcomingDeadlines(
      userId,
      DEADLINE_DAYS,
    );
    if (upcoming.length === 0) return 0;

    const lang = (await this.userMemory.getUserLanguage(userId)) ?? "ru";
    const copy = DEADLINE_COPY[lang];

    const lines = upcoming.map((d) => {
      const icon = d.sourceType === "document" ? "📄" : "📅";
      // German legal terms are only translated to Russian. For other languages
      // we keep the German label as-is — still actionable.
      const label = lang === "ru" ? translateDeadlineLabel(d.label) : d.label;
      const dateStr = copy.formatDate(d.deadlineDate);
      // ESCAPED: the label is built from document text — buildDeadlineLabel
      // slices around a matched date, and the app path takes it straight from
      // the local model. An "&" (Meier & Partner GmbH) or a "<" made Telegram
      // reject the whole message as unparseable HTML, sendToUser swallowed the
      // 400 into a warn, and the user's daily reminder simply never arrived.
      return `${icon} ${copy.entry(escapeHtml(label), d.daysLeft, dateStr)}`;
    });

    const message =
      `${copy.header(DEADLINE_DAYS)}\n\n` +
      lines.join("\n") +
      `\n\n${copy.footer}`;

    // SPLIT: getUpcomingDeadlines is capped at 200 rows, which is far past
    // Telegram's 4096-char limit — an over-long message was the same silent
    // loss by a different route.
    const parts = splitByChars(message);
    let delivered = 0;
    for (const part of parts) {
      if (await this.telegram.sendToUser(userId, part, "HTML")) delivered++;
    }
    if (delivered < parts.length) {
      // Loud on purpose: a reminder that did not arrive is the one failure
      // mode this whole feature exists to avoid.
      this.logger.error(
        `Deadline reminder for user ${userId}: only ${delivered}/${parts.length} message part(s) delivered`,
      );
    }
    return delivered > 0 ? lines.length : 0;
  }

  // ── Feature 2: Health monitoring ───────────────────────────────────────────

  /** Runs every 5 minutes. */
  @Cron("*/5 * * * *")
  async runHealthCheck(): Promise<void> {
    const start = Date.now();
    this.logger.debug("Health check started");

    let dbOk = true;
    let redisOk = true;
    let dbError = "";
    let redisError = "";

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (err) {
      dbOk = false;
      // Slice to 200 chars — PG error messages can contain connection strings
      dbError =
        err instanceof Error ? err.message.slice(0, 200) : "unknown error";
    }

    try {
      await this.cache.get("health:probe");
    } catch (err) {
      redisOk = false;
      redisError =
        err instanceof Error ? err.message.slice(0, 200) : "unknown error";
    }

    const healthy = dbOk && redisOk;
    // When Redis is down cache.get throws — default to false so the alert is always sent
    let alertAlreadySent = false;
    try {
      alertAlreadySent = (await this.cache.get(HEALTH_ALERT_KEY)) === "1";
    } catch {
      // Redis unavailable; treat as no prior alert sent
    }

    if (!healthy) {
      if (!alertAlreadySent) {
        const dbStatus = dbOk ? "✅" : `❌`;
        const redisStatus = redisOk ? "✅" : `❌`;
        const errorDetail = [
          !dbOk ? `DB: ${dbError}` : null,
          !redisOk ? `Redis: ${redisError}` : null,
        ]
          .filter(Boolean)
          .join("\n");

        const message =
          `⚠️ <b>Бот упал</b>\n` +
          `DB: ${dbStatus} / Redis: ${redisStatus}\n` +
          `<code>${errorDetail}</code>`;

        await this.telegram.sendToOwner(message, "HTML").catch((err: unknown) => {
          this.logger.warn(
            `Health alert send failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        });
        // Best-effort: when Redis is down this throws — and a throw here
        // would turn every 5-minute cron tick into a fresh owner alert for
        // the whole outage. The duplicate alert is the lesser evil.
        try {
          await this.cache.set(HEALTH_ALERT_KEY, "1", HEALTH_ALERT_TTL);
        } catch (err) {
          this.logger.warn(
            `Health alert dedup flag not stored (Redis down?): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        this.logger.warn(
          `Health check FAILED — alert sent (db=${dbOk}, redis=${redisOk})`,
        );
      } else {
        this.logger.warn(
          `Health check FAILED — alert already sent, suppressing (db=${dbOk}, redis=${redisOk})`,
        );
      }
    } else {
      if (alertAlreadySent) {
        // Recovery — previous run had an alert, now healthy
        await this.telegram
          .sendToOwner(
            "✅ <b>Бот восстановлен</b>\nВсё работает нормально.",
            "HTML",
          )
          .catch((err: unknown) => {
            this.logger.warn(
              `Health recovery send failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        try {
          await this.cache.del(HEALTH_ALERT_KEY);
        } catch (err) {
          this.logger.warn(
            `Health alert flag not cleared: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        this.logger.log("Health check RECOVERED — recovery message sent");
      } else {
        this.logger.debug(`Health check OK in ${Date.now() - start}ms`);
      }
    }
  }

  // ── Shared helper: fetch upcoming deadlines ────────────────────────────────

  /** Delegates to DeadlineService — kept for external callers (e.g. tests). */
  async getUpcomingDeadlines(
    userId: string,
    withinDays: number,
  ): Promise<DeadlineEntry[]> {
    return this.deadlines.getUpcomingDeadlines(userId, withinDays);
  }

  get deadlineSectionDays(): number {
    return DEADLINE_SECTION_DAYS;
  }
}

// ── i18n for deadline reminders ─────────────────────────────────────────────

interface DeadlineCopy {
  header: (days: number) => string;
  entry: (label: string, daysLeft: number, dateStr: string) => string;
  footer: string;
  formatDate: (d: Date) => string;
}

const DEADLINE_COPY: Record<UserLang, DeadlineCopy> = {
  ru: {
    header: (d) => `⏰ <b>Дедлайны на ближайшие ${d} дней</b>`,
    entry: (label, days, date) =>
      `${label} — через ${days} ${pluralDaysRu(days)} (${date})`,
    footer: "Используй /status чтобы увидеть все документы.",
    formatDate: (d) => fmtDate(d, "ru-RU"),
  },
  de: {
    header: (d) => `⏰ <b>Fristen in den nächsten ${d} Tagen</b>`,
    entry: (label, days, date) =>
      `${label} — in ${days} ${days === 1 ? "Tag" : "Tagen"} (${date})`,
    footer: "Verwende /status, um alle Dokumente zu sehen.",
    formatDate: (d) => fmtDate(d, "de-DE"),
  },
  en: {
    header: (d) => `⏰ <b>Deadlines in the next ${d} days</b>`,
    entry: (label, days, date) =>
      `${label} — in ${days} ${days === 1 ? "day" : "days"} (${date})`,
    footer: "Use /status to see all documents.",
    formatDate: (d) => fmtDate(d, "en-GB"),
  },
  uk: {
    header: (d) => `⏰ <b>Дедлайни на найближчі ${d} днів</b>`,
    entry: (label, days, date) =>
      `${label} — через ${days} ${pluralDaysUk(days)} (${date})`,
    footer: "Використовуй /status, щоб побачити всі документи.",
    formatDate: (d) => fmtDate(d, "uk-UA"),
  },
};

function pluralDaysRu(n: number): string {
  const abs = Math.abs(n);
  if (abs % 10 === 1 && abs % 100 !== 11) return "день";
  if (abs % 10 >= 2 && abs % 10 <= 4 && (abs % 100 < 10 || abs % 100 >= 20))
    return "дня";
  return "дней";
}

function pluralDaysUk(n: number): string {
  const abs = Math.abs(n);
  if (abs % 10 === 1 && abs % 100 !== 11) return "день";
  if (abs % 10 >= 2 && abs % 10 <= 4 && (abs % 100 < 10 || abs % 100 >= 20))
    return "дні";
  return "днів";
}

function fmtDate(d: Date, locale: string): string {
  return d.toLocaleDateString(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}
