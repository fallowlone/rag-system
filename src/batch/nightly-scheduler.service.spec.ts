import { Queue } from "bullmq";
import { NightlyBatchScheduler } from "./nightly-scheduler.service";
import { PrismaService } from "../prisma/prisma.service";
import { berlinDayStart } from "./berlin-day";

function buildScheduler(options: {
  activity: Array<{ userId: string; createdAt: Date }>;
  states?: Array<{ userId: string; processedDate: Date; status: string }>;
  addImpl?: jest.Mock;
  getJobImpl?: jest.Mock;
  dispatchFails?: boolean;
}) {
  const prisma = {
    conversationLog: {
      findMany: options.dispatchFails
        ? jest.fn().mockRejectedValue(new Error("db down"))
        : jest.fn().mockResolvedValue(options.activity),
    },
    batchJobState: {
      findMany: jest.fn().mockResolvedValue(options.states ?? []),
    },
  } as unknown as PrismaService;
  const add = options.addImpl ?? jest.fn().mockResolvedValue({ id: "job-1" });
  const queue = {
    add,
    getJob: options.getJobImpl ?? jest.fn().mockResolvedValue(null),
  } as unknown as Queue;
  const scheduler = new NightlyBatchScheduler(prisma, queue);
  return { scheduler, prisma, add, queue };
}

describe("NightlyBatchScheduler window dispatch", () => {
  it("enqueues one job per active (user, Berlin-day) pair and skips completed/running days", async () => {
    const recent = new Date(Date.now() - 36 * 60 * 60 * 1_000);
    const dayIso = berlinDayStart(recent).toISOString();
    const { scheduler, add } = buildScheduler({
      activity: [
        { userId: "user-1", createdAt: recent },
        { userId: "user-1", createdAt: recent },
        { userId: "user-2", createdAt: recent },
      ],
      states: [
        {
          userId: "user-2",
          processedDate: new Date(dayIso),
          status: "completed",
        },
      ],
    });

    await scheduler.dispatchNightlyBatch();

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      "consolidate",
      { userId: "user-1", processedDateIso: dayIso },
      expect.objectContaining({
        jobId: `nightly:user-1:${dayIso}`,
        attempts: 3,
      }),
    );
  });

  it("ignores activity outside the retry window", async () => {
    const recent = new Date(Date.now() - 36 * 60 * 60 * 1_000);
    const ancient = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
    const { scheduler, add } = buildScheduler({
      activity: [
        { userId: "user-1", createdAt: recent },
        { userId: "user-old", createdAt: ancient },
      ],
    });

    await scheduler.dispatchNightlyBatch();

    expect(add).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      "consolidate",
      expect.objectContaining({ userId: "user-1" }),
      expect.anything(),
    );
  });

  it("resolves without enqueueing when nobody was active", async () => {
    const { scheduler, add } = buildScheduler({ activity: [] });

    await scheduler.dispatchNightlyBatch();

    expect(add).not.toHaveBeenCalled();
  });

  it("rethrows when the dispatch query fails instead of silently dropping the day", async () => {
    const { scheduler, add } = buildScheduler({
      activity: [],
      dispatchFails: true,
    });

    await expect(scheduler.dispatchNightlyBatch()).rejects.toThrow("db down");
    expect(add).not.toHaveBeenCalled();
  });
});

describe("NightlyBatchScheduler failed-day re-enqueue", () => {
  it("removes the terminal BullMQ record before re-adding a failed day", async () => {
    const recent = new Date(Date.now() - 36 * 60 * 60 * 1_000);
    const dayIso = berlinDayStart(recent).toISOString();
    const remove = jest.fn().mockResolvedValue(undefined);
    const getJob = jest.fn().mockResolvedValue({
      getState: jest.fn().mockResolvedValue("failed"),
      remove,
    });
    const { scheduler, add } = buildScheduler({
      activity: [{ userId: "user-1", createdAt: recent }],
      states: [
        { userId: "user-1", processedDate: new Date(dayIso), status: "failed" },
      ],
      getJobImpl: getJob,
    });

    await scheduler.dispatchNightlyBatch();

    expect(remove).toHaveBeenCalledTimes(1);
    expect(add).toHaveBeenCalledWith(
      "consolidate",
      { userId: "user-1", processedDateIso: dayIso },
      expect.objectContaining({ jobId: `nightly:user-1:${dayIso}` }),
    );
  });

  it("leaves a still-active job record alone on a failed-marked day", async () => {
    const recent = new Date(Date.now() - 36 * 60 * 60 * 1_000);
    const dayIso = berlinDayStart(recent).toISOString();
    const remove = jest.fn().mockResolvedValue(undefined);
    const getJob = jest.fn().mockResolvedValue({
      // A rate-limited retry in flight: failed in batchJobState, delayed in BullMQ.
      getState: jest.fn().mockResolvedValue("delayed"),
      remove,
    });
    const { scheduler, add } = buildScheduler({
      activity: [{ userId: "user-1", createdAt: recent }],
      states: [
        { userId: "user-1", processedDate: new Date(dayIso), status: "failed" },
      ],
      getJobImpl: getJob,
    });

    await scheduler.dispatchNightlyBatch();

    expect(remove).not.toHaveBeenCalled();
    // Re-adding the same stable jobId is a BullMQ-level no-op for the live record.
    expect(add).toHaveBeenCalledTimes(1);
  });

  it("a failing enqueue does not drop the remaining pairs but surfaces at the end", async () => {
    const recent = new Date(Date.now() - 36 * 60 * 60 * 1_000);
    const add = jest
      .fn()
      .mockRejectedValueOnce(new Error("redis down"))
      .mockResolvedValue({ id: "job-2" });
    const { scheduler } = buildScheduler({
      activity: [
        { userId: "user-1", createdAt: recent },
        { userId: "user-2", createdAt: recent },
      ],
      addImpl: add,
    });

    await expect(scheduler.dispatchNightlyBatch()).rejects.toThrow(
      "1 enqueue(s) failed",
    );
    expect(add).toHaveBeenCalledTimes(2);
  });
});
