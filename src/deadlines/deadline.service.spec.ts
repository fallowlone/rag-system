import { DeadlineService, MAX_DEADLINE_HORIZON_DAYS } from "./deadline.service";
import { PrismaService } from "../prisma/prisma.service";

describe("DeadlineService.saveDeadlines result contract", () => {
  function buildService(options?: {
    findFirst?: jest.Mock;
    create?: jest.Mock;
  }) {
    const prisma = {
      userDeadline: {
        findFirst:
          options?.findFirst ?? jest.fn().mockResolvedValue(null),
        create: options?.create ?? jest.fn().mockResolvedValue({ id: "dl-1" }),
      },
    } as unknown as PrismaService;
    return { service: new DeadlineService(prisma), prisma };
  }

  it("saveDeadlinesFromDocument resolves true on success", async () => {
    const { service } = buildService();

    await expect(
      service.saveDeadlinesFromDocument(
        "user-1",
        "doc-1",
        new Date("2026-10-01T00:00:00Z"),
        "Bescheid",
      ),
    ).resolves.toBe(true);
  });

  it("saveDeadlinesFromDocument resolves false (never throws) on a DB failure", async () => {
    const { service } = buildService({
      findFirst: jest.fn().mockRejectedValue(new Error("db down")),
    });

    await expect(
      service.saveDeadlinesFromDocument(
        "user-1",
        "doc-1",
        new Date("2026-10-01T00:00:00Z"),
        "Bescheid",
      ),
    ).resolves.toBe(false);
  });

  it("saveDeadlinesFromMemory resolves true when no dates are found", async () => {
    const { service, prisma } = buildService();

    await expect(
      service.saveDeadlinesFromMemory("user-1", "m1", "no dates here"),
    ).resolves.toBe(true);
    expect(prisma.userDeadline.findFirst).not.toHaveBeenCalled();
  });
});

describe("DeadlineService.deleteDeadlinesBySource scoping", () => {
  it("scopes the delete query to both sourceId and userId", async () => {
    const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    const prisma = {
      userDeadline: { deleteMany },
    } as unknown as PrismaService;

    const service = new DeadlineService(prisma);
    await service.deleteDeadlinesBySource("doc-123", "user-456");

    expect(deleteMany).toHaveBeenCalledWith({
      where: { sourceId: "doc-123", userId: "user-456" },
    });
  });

  it("logs a warning and rethrows when the delete fails (callers must not silently orphan tracker rows)", async () => {
    const deleteMany = jest.fn().mockRejectedValue(new Error("db error"));
    const prisma = {
      userDeadline: { deleteMany },
    } as unknown as PrismaService;

    const service = new DeadlineService(prisma);
    await expect(
      service.deleteDeadlinesBySource("doc-123", "user-456"),
    ).rejects.toThrow("db error");
  });
});

describe("DeadlineService.setDeadlineCompleted", () => {
  function buildService() {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      userDeadline: { updateMany, findMany },
    } as unknown as PrismaService;
    return { service: new DeadlineService(prisma), updateMany, findMany };
  }

  it("completes an owned deadline with an owner-scoped update", async () => {
    const { service, updateMany } = buildService();

    await expect(
      service.setDeadlineCompleted("user-1", "dl-1", true),
    ).resolves.toBe(true);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "dl-1", userId: "user-1" },
      data: { completedAt: expect.any(Date) },
    });
  });

  it("reopens with completedAt null and reports a foreign id as false", async () => {
    const { service, updateMany } = buildService();
    updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.setDeadlineCompleted("user-1", "foreign", false),
    ).resolves.toBe(false);

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "foreign", userId: "user-1" },
      data: { completedAt: null },
    });
  });

  it("getUpcomingDeadlines excludes completed deadlines", async () => {
    const { service, findMany } = buildService();

    await service.getUpcomingDeadlines("user-1", 30);

    // A completed deadline must not resurface in the morning tracker.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ completedAt: null }),
      }),
    );
  });
});

describe("DeadlineService cross-writer dedup and horizon", () => {
  function buildService(existing: unknown = null) {
    const findFirst = jest.fn().mockResolvedValue(existing);
    const create = jest.fn().mockResolvedValue({ id: "dl-1" });
    const prisma = {
      userDeadline: { findFirst, create },
    } as unknown as PrismaService;
    return { service: new DeadlineService(prisma), findFirst, create };
  }

  it("checks the owning document's own deadline row, not just the memory's", async () => {
    // Two writers create deadlines for one document: the model's structured
    // deadlines[] (sourceId = documentId) and this regex pass over each fact
    // (sourceId = memoryId). Keyed on sourceId alone the check never matched
    // across them, so one Frist produced two rows — two reminders at 09:00,
    // and completing one left the other open.
    const { service, findFirst } = buildService();

    await service.saveDeadlinesFromMemory(
      "user-1",
      "mem-1",
      "Widerspruchsfrist bis 01.05.2027",
      "doc-1",
    );

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          OR: [{ sourceId: "mem-1" }, { sourceId: "doc-1" }],
        }),
      }),
    );
  });

  it("keeps the memory-only check when the fact belongs to no document", async () => {
    const { service, findFirst } = buildService();

    await service.saveDeadlinesFromMemory(
      "user-1",
      "mem-1",
      "Termin am 01.05.2027",
    );

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ OR: [{ sourceId: "mem-1" }] }),
      }),
    );
  });

  it("skips the write when the document already covers that day", async () => {
    const { service, create } = buildService({ id: "existing" });

    await service.saveDeadlinesFromMemory(
      "user-1",
      "mem-1",
      "Widerspruchsfrist bis 01.05.2027",
      "doc-1",
    );

    expect(create).not.toHaveBeenCalled();
  });

  it("tracks the multi-year documents this product exists for", () => {
    // A Mietvertrag runs two to three years and an Aufenthaltstitel one to
    // three; the old 365-day horizon dropped both.
    expect(MAX_DEADLINE_HORIZON_DAYS).toBeGreaterThanOrEqual(3 * 365);
  });
});
