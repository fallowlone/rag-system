import { ConflictException } from "@nestjs/common";
import { SyncSchedulerService } from "./sync-scheduler.service";
import { PrismaService } from "../prisma/prisma.service";
import { GiiCrawlerService } from "./gii-crawler.service";
import { IngestionService } from "./ingestion.service";

describe("SyncSchedulerService overlap guard", () => {
  function buildService(options?: {
    ingestAll?: jest.Mock;
    fetchIndex?: jest.Mock;
    upsertLaws?: jest.Mock;
  }) {
    const ingestAll =
      options?.ingestAll ??
      jest.fn().mockResolvedValue({
        processed: 1,
        skipped: 0,
        failed: 0,
        totalChunks: 5,
      });
    const service = new SyncSchedulerService(
      {} as PrismaService,
      {
        fetchIndex:
          options?.fetchIndex ?? jest.fn().mockResolvedValue([]),
        upsertLaws: options?.upsertLaws ?? jest.fn().mockResolvedValue(undefined),
      } as unknown as GiiCrawlerService,
      { ingestAll } as unknown as IngestionService,
    );
    return { service, ingestAll };
  }

  it("skips the tick (no throw) when a full ingestion is already running", async () => {
    const ingestAll = jest.fn().mockRejectedValue(new ConflictException("busy"));
    const { service } = buildService({ ingestAll });

    await expect(service.dailySync()).resolves.toBeUndefined();
    expect(ingestAll).toHaveBeenCalledTimes(1);
  });

  it("completes normally when no ingestion is running", async () => {
    const { service } = buildService();

    await expect(service.dailySync()).resolves.toBeUndefined();
  });

  it("rethrows non-overlap failures instead of swallowing them", async () => {
    const { service } = buildService({
      ingestAll: jest.fn().mockRejectedValue(new Error("crawler down")),
    });

    await expect(service.dailySync()).rejects.toThrow("crawler down");
  });

  it("skips fullSync (no throw, no ingest) when the index crawl fails", async () => {
    const ingestAll = jest.fn();
    const { service } = buildService({
      ingestAll,
      fetchIndex: jest.fn().mockRejectedValue(new Error("TOC outage")),
    });

    await expect(service.fullSync()).resolves.toBeUndefined();
    expect(ingestAll).not.toHaveBeenCalled();
  });
});
