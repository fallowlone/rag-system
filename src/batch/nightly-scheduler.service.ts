import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectQueue } from "@nestjs/bullmq";
import { Queue } from "bullmq";
import { fromZonedTime, toZonedTime } from "date-fns-tz";
import { startOfDay, subDays } from "date-fns";
import { PrismaService } from "../prisma/prisma.service";
import {
  NIGHTLY_BATCH_JOB,
  NIGHTLY_BATCH_QUEUE,
  NightlyBatchPayload,
} from "./batch.types";
import {
  berlinDayEnd,
  berlinDayStart,
  berlinDayStartDaysAgo,
} from "./berlin-day";

const TZ = "Europe/Berlin";

// Failed days are re-enqueued for this long: a day whose jobs exhausted
// their attempts (or whose job records were lost in a Redis restart —
// persistence is intentionally off) gets a fresh job every night until it
// succeeds or ages out of the window.
const FAILED_RETRY_DAYS = 7;

function nightlyJobId(userId: string, processedDateIso: string): string {
  return `nightly:${userId}:${processedDateIso}`;
}

@Injectable()
export class NightlyBatchScheduler {
  private readonly logger = new Logger(NightlyBatchScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(NIGHTLY_BATCH_QUEUE) private readonly queue: Queue,
  ) {}

  /**
   * Fires daily at 00:05 Europe/Berlin and enqueues a consolidation job for
   * every (user, Berlin-day) pair with chat activity in the trailing
   * FAILED_RETRY_DAYS window that is not already completed. Covering the
   * window (not just yesterday) re-enqueues days whose jobs exhausted their
   * attempts or whose BullMQ records vanished in a Redis restart. The cron is
   * offset 5 minutes past midnight to give any in-flight chat turn a chance
   * to finish dual-writing.
   */
  @Cron("5 0 * * *", { timeZone: TZ })
  async dispatchNightlyBatch(): Promise<void> {
    const processedDate = computeProcessedDate(new Date());
    const dayEnd = berlinDayEnd(processedDate);
    const windowStart = berlinDayStartDaysAgo(
      processedDate,
      FAILED_RETRY_DAYS - 1,
    );

    let activity: Array<{ userId: string; createdAt: Date }>;
    try {
      activity = await this.prisma.conversationLog.findMany({
        where: { createdAt: { gte: windowStart, lt: dayEnd } },
        select: { userId: true, createdAt: true },
      });
    } catch (err) {
      this.logger.error(
        `Nightly dispatch query failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      throw err;
    }

    // Bucket activity rows into their Berlin calendar days.
    const pairs = new Map<string, NightlyBatchPayload>();
    for (const row of activity) {
      const dayStart = berlinDayStart(row.createdAt);
      if (dayStart < windowStart || dayStart >= dayEnd) continue;
      const processedDateIso = dayStart.toISOString();
      pairs.set(`${row.userId}@${processedDateIso}`, {
        userId: row.userId,
        processedDateIso,
      });
    }

    if (pairs.size === 0) {
      this.logger.log(
        `Nightly dispatch for ${processedDate.toISOString()}: no active users`,
      );
      return;
    }

    // Skip days already completed or claimed-running; failed days are
    // re-enqueued below (with their stale BullMQ record cleared first).
    const states = await this.prisma.batchJobState.findMany({
      where: { processedDate: { gte: windowStart, lt: dayEnd } },
      select: { userId: true, processedDate: true, status: true },
    });
    const statusByPair = new Map(
      states.map((s) => [
        `${s.userId}@${s.processedDate.toISOString()}`,
        s.status,
      ]),
    );

    let enqueued = 0;
    const failures: string[] = [];
    for (const [key, payload] of pairs) {
      const status = statusByPair.get(key);
      if (status === "completed" || status === "running") continue;
      try {
        if (status === "failed") {
          await this.clearTerminalJobRecord(payload);
        }
        await this.queue.add(NIGHTLY_BATCH_JOB, payload, {
          // Stable per-day job id makes a re-run a no-op rather than a
          // duplicate enqueue if the cron fires twice (e.g. container restart
          // exactly at midnight).
          jobId: nightlyJobId(payload.userId, payload.processedDateIso),
          attempts: 3,
          backoff: { type: "exponential", delay: 30_000 },
          removeOnComplete: { count: 200, age: 30 * 24 * 60 * 60 },
          removeOnFail: { count: 100, age: 30 * 24 * 60 * 60 },
        });
        enqueued += 1;
      } catch (err) {
        // One pair's failure must not silently drop the rest — collect and
        // rethrow at the end so the miss is visible and counted.
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.error(`Nightly dispatch enqueue failed for ${key}: ${reason}`);
        failures.push(`${key}: ${reason}`);
      }
    }

    this.logger.log(
      `Nightly dispatch for ${processedDate.toISOString()}: enqueued ${enqueued} job(s), skipped ${pairs.size - enqueued - failures.length}, failed ${failures.length}`,
    );
    if (failures.length > 0) {
      throw new Error(
        `Nightly dispatch: ${failures.length} enqueue(s) failed: ${failures.join("; ").slice(0, 500)}`,
      );
    }
  }

  /**
   * Clears a terminal (failed) BullMQ record for a failed day so the fresh
   * enqueue below actually creates a job: re-adding a duplicate jobId while
   * its record exists is a silent no-op. Records that are still
   * waiting/active/delayed own the day and are left alone.
   */
  private async clearTerminalJobRecord(
    payload: NightlyBatchPayload,
  ): Promise<void> {
    const jobId = nightlyJobId(payload.userId, payload.processedDateIso);
    const prev = await this.queue.getJob(jobId);
    if (!prev) return;
    let state: string;
    try {
      state = await prev.getState();
    } catch (err) {
      this.logger.warn(
        `Nightly dispatch: could not read state of ${jobId}, attempting remove: ${err instanceof Error ? err.message : String(err)}`,
      );
      state = "unknown";
    }
    if (state !== "failed" && state !== "unknown") return;
    try {
      await prev.remove();
    } catch (err) {
      this.logger.warn(
        `Nightly dispatch: could not remove terminal job ${jobId} (continuing): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Returns the UTC instant corresponding to Europe/Berlin start-of-day for the
 * day that just ended (i.e. yesterday). Called at 00:05 Berlin local, so
 * "now" in Berlin is just past midnight; subtract one day, take start-of-day
 * in Berlin, then map back to UTC.
 */
function computeProcessedDate(now: Date): Date {
  const nowInBerlin = toZonedTime(now, TZ);
  const yesterdayInBerlin = subDays(nowInBerlin, 1);
  const startBerlin = startOfDay(yesterdayInBerlin);
  return fromZonedTime(startBerlin, TZ);
}
