import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../prisma/prisma.service";
import { CacheService } from "../cache/cache.service";
import { TelegramService } from "../telegram/telegram.service";

const TZ = "Europe/Berlin";
const REASK_DAYS = 3;
const MAX_PUSHES = 3;
// Single-flight across replicas: two app instances must not both push the
// morning batch (double Telegram messages). First writer wins; the lock
// outlives any single run so a crashed holder cannot wedge tomorrow.
const MORNING_PUSH_LOCK_SECONDS = 600;

interface ConflictRow {
  conflictGroupId: string;
  userId: string;
  pushCount: number;
  lastPushedAt: Date;
}

interface ConflictMember {
  id: string;
  content: string;
  createdAt: Date;
}

@Injectable()
export class ConflictPushService {
  private readonly logger = new Logger(ConflictPushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly telegram: TelegramService,
  ) {}

  /**
   * 09:00 Europe/Berlin — picks unresolved conflict groups whose last push
   * was at least REASK_DAYS ago (or never pushed) and either auto-resolves
   * after MAX_PUSHES nudges or asks the user via Telegram inline keyboard.
   */
  @Cron("0 9 * * *", { timeZone: TZ })
  async runMorningPush(): Promise<void> {
    const owned = await this.cache.setJsonNx(
      "cronlock:morning-push",
      { at: new Date().toISOString() },
      MORNING_PUSH_LOCK_SECONDS,
    );
    if (!owned) {
      this.logger.log(
        "Morning push skipped: owned by another replica",
      );
      return;
    }
    const reaskCutoff = new Date(
      Date.now() - REASK_DAYS * 24 * 60 * 60 * 1_000,
    );

    let conflicts: ConflictRow[];
    try {
      conflicts = await this.prisma.conflictPushState.findMany({
        where: {
          resolvedAt: null,
          OR: [{ pushCount: 0 }, { lastPushedAt: { lt: reaskCutoff } }],
        },
        orderBy: { lastPushedAt: "asc" },
        take: 50, // safety cap per cron tick
      });
    } catch (err) {
      this.logger.error(
        `Conflict push query failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    if (conflicts.length === 0) {
      this.logger.debug("Morning push: no conflicts pending");
      return;
    }

    for (const conflict of conflicts) {
      try {
        await this.handleConflict(conflict);
      } catch (err) {
        this.logger.warn(
          `Conflict push for group ${conflict.conflictGroupId} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async handleConflict(conflict: ConflictRow): Promise<void> {
    const members = await this.fetchMembers(conflict.conflictGroupId);

    if (members.length < 2) {
      // Loose ends — group was already resolved or rows were deleted.
      // Mark as resolved so it stops showing up.
      await this.prisma.conflictPushState.update({
        where: { conflictGroupId: conflict.conflictGroupId },
        data: { resolvedAt: new Date() },
      });
      return;
    }

    if (conflict.pushCount >= MAX_PUSHES) {
      await this.autoResolve(conflict, members);
      return;
    }

    if (Number.isNaN(Number(conflict.userId))) {
      // Poison-pill guard: sendConflictPrompt can never deliver to a
      // non-numeric id (returns false without touching pushCount), so without
      // this the row would occupy the take:50 window forever. All Telegram
      // user ids are numeric — resolve the invariant violation loudly.
      this.logger.warn(
        `Conflict ${conflict.conflictGroupId} has non-numeric userId "${conflict.userId}" — resolving without push`,
      );
      await this.prisma.conflictPushState.update({
        where: { conflictGroupId: conflict.conflictGroupId },
        data: { resolvedAt: new Date() },
      });
      return;
    }

    const sent = await this.telegram.sendConflictPrompt({
      userId: conflict.userId,
      groupId: conflict.conflictGroupId,
      members,
    });

    if (!sent) {
      // Telegram delivery failed; do not increment pushCount so the next run
      // can retry without "burning" an attempt.
      this.logger.warn(
        `Telegram delivery failed for conflict ${conflict.conflictGroupId} — will retry on next push`,
      );
      return;
    }

    await this.prisma.conflictPushState.update({
      where: { conflictGroupId: conflict.conflictGroupId },
      data: { lastPushedAt: new Date(), pushCount: { increment: 1 } },
    });
  }

  private async autoResolve(
    conflict: ConflictRow,
    members: ConflictMember[],
  ): Promise<void> {
    const winner = members
      .slice()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]!;

    await this.prisma.$transaction([
      this.prisma.userMemory.update({
        where: { id: winner.id },
        data: { status: "active", conflictGroupId: null },
      }),
      this.prisma.userMemory.updateMany({
        where: {
          conflictGroupId: conflict.conflictGroupId,
          userId: conflict.userId,
          id: { not: winner.id },
        },
        data: { status: "stale", conflictGroupId: null },
      }),
      this.prisma.conflictPushState.update({
        where: { conflictGroupId: conflict.conflictGroupId },
        data: { resolvedAt: new Date() },
      }),
    ]);

    this.logger.log(
      `Conflict ${conflict.conflictGroupId} auto-resolved to most-recent fact ${winner.id} after ${conflict.pushCount} unanswered push(es)`,
    );

    // The loser dies silently otherwise: tell the user which variant survived
    // (sendToUser is fire-and-forget safe — invalid ids and delivery errors
    // only warn inside TelegramService).
    const winnerText =
      winner.content.length > 200
        ? `${winner.content.slice(0, 200)}…`
        : winner.content;
    await this.telegram.sendToUser(
      conflict.userId,
      `Ты не ответил на ${conflict.pushCount} напоминания о противоречии, поэтому я оставил самый свежий вариант:\n«${winnerText}»\nЕсли это ошибка — напиши мне, и я исправлю.`,
    );
  }

  private async fetchMembers(groupId: string): Promise<ConflictMember[]> {
    return this.prisma.userMemory.findMany({
      where: { conflictGroupId: groupId, status: "pending" },
      orderBy: { createdAt: "asc" },
      select: { id: true, content: true, createdAt: true },
    });
  }
}
