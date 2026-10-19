import { BadRequestException } from "@nestjs/common";
import {
  AppSyncService,
  encodeSyncCursor,
  parseSyncCursor,
} from "./app-sync.service";
import { PrismaService } from "../prisma/prisma.service";

const docRow = {
  id: "doc-1",
  fileName: "bescheid.pdf",
  title: "Bewilligungsbescheid",
  category: "jobcenter",
  factsCount: 3,
  summary: "Bewilligung ab 01.10.2026",
  isActive: true,
  status: "active",
  appSource: true,
  expiryDate: null,
  docDate: new Date("2026-08-01T00:00:00Z"),
  createdAt: new Date("2026-08-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
  tagLinks: [
    { tag: { id: "tag-1", name: "Bürgergeld", color: "#ff0000" } },
  ],
};

const deadlineRow = {
  id: "dl-1",
  label: "Widerspruch einlegen",
  deadlineDate: new Date("2026-09-01T00:00:00Z"),
  sourceType: "document",
  sourceId: "doc-1",
  completedAt: null,
  createdAt: new Date("2026-08-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
};

const taskRow = {
  id: "task-1",
  title: "Nachweis einreichen",
  description: null,
  dueDate: new Date("2026-09-01T00:00:00Z"),
  status: "open",
  priority: "normal",
  sourceType: "document",
  sourceDocumentId: "doc-1",
  completedAt: null,
  createdAt: new Date("2026-08-01T00:00:00Z"),
  updatedAt: new Date("2026-08-01T00:00:00Z"),
};

const insightRow = {
  id: "insight-1",
  userId: "user-1",
  documentId: "doc-1",
  kind: "next_step",
  severity: "high",
  title: "Widerspruch einlegen",
  body: "Frist beachten.",
  sourceHash: "ab".repeat(32),
  model: "claude-sonnet-5",
  createdAt: new Date("2026-08-02T00:00:00Z"),
};

const SERVER_NOW = new Date("2026-08-22T10:00:00Z");

describe("AppSyncService", () => {
  function buildService(options?: {
    docRows?: typeof docRow[];
    deadlineRows?: typeof deadlineRow[];
    taskRows?: typeof taskRow[];
    // documentInsight.findMany is called twice per delta (page-docs leg,
    // then the created-after-cursor leg) — mock each leg separately.
    insightForDocs?: typeof insightRow[];
    insightRecent?: typeof insightRow[];
  }) {
    const prisma = {
      userDocument: {
        findMany: jest.fn().mockResolvedValue(options?.docRows ?? [docRow]),
      },
      userDeadline: {
        findMany: jest
          .fn()
          .mockResolvedValue(options?.deadlineRows ?? [deadlineRow]),
      },
      userTask: {
        findMany: jest.fn().mockResolvedValue(options?.taskRows ?? [taskRow]),
      },
      documentInsight: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce(options?.insightForDocs ?? [])
          .mockResolvedValueOnce(options?.insightRecent ?? []),
      },
      syncTombstone: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ now: SERVER_NOW }]),
    } as unknown as PrismaService;
    return { service: new AppSyncService(prisma), prisma };
  }

  it("full pull (no cursor) returns all collections and keyset nextCursor", async () => {
    const { service, prisma } = buildService();

    const result = await service.delta("user-1", { limit: 200 });

    expect(result.documents).toHaveLength(1);
    expect(result.documents[0].tags).toEqual([
      { id: "tag-1", name: "Bürgergeld", color: "#ff0000" },
    ]);
    expect(result.deadlines).toHaveLength(1);
    expect(result.deadlines[0].label).toBe("Widerspruch einlegen");
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].status).toBe("open");
    expect(result.serverTime).toEqual(SERVER_NOW);
    expect(result.hasMore).toBe(false);

    // The cursor carries per-collection keyset positions, not wall-clock
    // time: resuming from it must not skip or repeat rows.
    const cursor = parseSyncCursor(result.nextCursor);
    expect(cursor.docs).toEqual({
      t: docRow.updatedAt.toISOString(),
      id: docRow.id,
    });
    expect(cursor.deadlines).toEqual({
      t: deadlineRow.updatedAt.toISOString(),
      id: deadlineRow.id,
    });
    expect(cursor.tasks).toEqual({
      t: taskRow.updatedAt.toISOString(),
      id: taskRow.id,
    });

    // No cursor → no updatedAt filter in any where clause, and every
    // collection orders by (updatedAt, id) for stable keyset paging.
    const keysetOrder = [{ updatedAt: "asc" }, { id: "asc" }];
    expect(prisma.userDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1" },
        orderBy: keysetOrder,
      }),
    );
    expect(prisma.userDeadline.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1" },
        orderBy: keysetOrder,
      }),
    );
    expect(prisma.userTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1" },
        orderBy: keysetOrder,
      }),
    );
  });

  it("legacy ISO cursor applies a keyset filter to every collection", async () => {
    const { service, prisma } = buildService();
    const cursor = "2026-08-20T00:00:00.000Z";

    await service.delta("user-1", { cursor, limit: 100 });

    const expectedFilter = {
      userId: "user-1",
      OR: [
        { updatedAt: { gt: new Date(cursor) } },
        { updatedAt: new Date(cursor), id: { gt: "" } },
      ],
    };
    expect(prisma.userDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedFilter }),
    );
    expect(prisma.userDeadline.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedFilter }),
    );
    expect(prisma.userTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expectedFilter }),
    );
  });

  it("pages a full collection across polls without losing rows", async () => {
    const older = { ...docRow, id: "doc-older" };
    const newer = {
      ...docRow,
      id: "doc-newer",
      updatedAt: new Date("2026-08-05T00:00:00Z"),
    };
    const prisma = {
      userDocument: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([older, docRow])
          .mockResolvedValueOnce([newer]),
      },
      userDeadline: { findMany: jest.fn().mockResolvedValue([]) },
      userTask: { findMany: jest.fn().mockResolvedValue([]) },
      documentInsight: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      syncTombstone: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ now: SERVER_NOW }]),
    } as unknown as PrismaService;
    const service = new AppSyncService(prisma);

    const first = await service.delta("user-1", { limit: 2 });
    expect(first.documents.map((d) => d.id)).toEqual(["doc-older", "doc-1"]);
    expect(first.hasMore).toBe(true);

    // The second poll resumes strictly after the last returned row —
    // under the old wall-clock cursor the overflow row (older than the
    // response's serverTime) would have been skipped forever.
    const second = await service.delta("user-1", {
      cursor: first.nextCursor,
      limit: 2,
    });
    expect(second.documents.map((d) => d.id)).toEqual(["doc-newer"]);
    expect(second.hasMore).toBe(false);
    expect(prisma.userDocument.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-1",
          OR: [
            { updatedAt: { gt: docRow.updatedAt } },
            { updatedAt: docRow.updatedAt, id: { gt: "doc-1" } },
          ],
        },
      }),
    );
  });

  it("resumes inside a shared updatedAt instant via the id tiebreak", async () => {
    const instant = new Date("2026-08-03T00:00:00Z");
    const a = { ...docRow, id: "doc-a", updatedAt: instant };
    const b = { ...docRow, id: "doc-b", updatedAt: instant };
    const c = { ...docRow, id: "doc-c", updatedAt: instant };
    const prisma = {
      userDocument: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([a, b])
          .mockResolvedValueOnce([c]),
      },
      userDeadline: { findMany: jest.fn().mockResolvedValue([]) },
      userTask: { findMany: jest.fn().mockResolvedValue([]) },
      documentInsight: { findMany: jest.fn().mockResolvedValue([]) },
      syncTombstone: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ now: SERVER_NOW }]),
    } as unknown as PrismaService;
    const service = new AppSyncService(prisma);

    const first = await service.delta("user-1", { limit: 2 });
    expect(first.hasMore).toBe(true);

    const second = await service.delta("user-1", {
      cursor: first.nextCursor,
      limit: 2,
    });
    // Same instant, strictly greater id — row c is neither skipped (strict
    // gt on the instant alone would lose it) nor repeated (a/b excluded).
    expect(second.documents.map((d) => d.id)).toEqual(["doc-c"]);
    expect(prisma.userDocument.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: {
          userId: "user-1",
          OR: [{ updatedAt: { gt: instant } }, { updatedAt: instant, id: { gt: "doc-b" } }],
        },
      }),
    );
  });

  it("rejects a garbage cursor with 400", async () => {
    const { service } = buildService();
    await expect(
      service.delta("user-1", { cursor: "not-a-date", limit: 10 }),
    ).rejects.toThrow(BadRequestException);
  });

  it("rejects an opaque cursor with a garbage date with 400 (not 500)", async () => {
    const { service } = buildService();
    const raw = Buffer.from(
      JSON.stringify({
        v: 1,
        docs: { t: "not-a-date", id: "" },
        deadlines: null,
        tasks: null,
        insights: null,
      }),
      "utf8",
    ).toString("base64url");
    await expect(
      service.delta("user-1", { cursor: raw, limit: 10 }),
    ).rejects.toThrow(BadRequestException);
  });

  it("delivers an insight present in both legs exactly once (first-pull overlap)", async () => {
    // cursor=null makes the recent leg return every insight, including those
    // already carried by the page docs — pageInsights + recentInsights must
    // dedupe by id.
    const { service } = buildService({
      insightForDocs: [insightRow],
      insightRecent: [insightRow],
    });

    const result = await service.delta("user-1", { limit: 200 });

    expect(result.documents[0].insights).toHaveLength(1);
    expect(result.documents[0].insights[0].id).toBe(insightRow.id);
  });

  it("backfills the parent document of an insight newer than the docs cursor", async () => {
    // Regression: an insight created after the cursor for a document older
    // than the docs cursor (analyze retry on an old document) landed in
    // recentInsights but never in the response — while the insights cursor
    // advanced past it, losing it forever. The parent must ride along.
    const oldDoc = {
      ...docRow,
      id: "doc-old",
      updatedAt: new Date("2026-07-01T00:00:00Z"),
    };
    const orphanInsight = { ...insightRow, id: "insight-orphan", documentId: "doc-old" };
    const cursor = encodeSyncCursor({
      v: 1,
      docs: { t: "2026-08-01T00:00:00.000Z", id: "doc-1" },
      deadlines: null,
      tasks: null,
      insights: null,
      deleted: null,
    });
    const prisma = {
      // Page docs: only the new document; the old parent is past the cursor.
      userDocument: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([docRow])
          .mockResolvedValueOnce([oldDoc]),
      },
      userDeadline: { findMany: jest.fn().mockResolvedValue([]) },
      userTask: { findMany: jest.fn().mockResolvedValue([]) },
      documentInsight: {
        findMany: jest
          .fn()
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([orphanInsight]),
      },
      syncTombstone: {
        findMany: jest.fn().mockResolvedValue([]),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ now: SERVER_NOW }]),
    } as unknown as PrismaService;
    const service = new AppSyncService(prisma);

    const result = await service.delta("user-1", { cursor, limit: 200 });

    const parent = result.documents.find((d) => d.id === "doc-old");
    expect(parent).toBeDefined();
    expect(parent?.insights).toHaveLength(1);
    expect(parent?.insights[0].id).toBe("insight-orphan");
    expect(prisma.userDocument.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.userDocument.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { userId: "user-1", id: { in: ["doc-old"] } },
      }),
    );
  });

  it("delivers deletion tombstones grouped by collection", async () => {
    const tombstones = [
      {
        id: "t-1",
        userId: "user-1",
        collection: "document",
        objectId: "doc-gone",
        deletedAt: new Date("2026-08-10T00:00:00Z"),
      },
      {
        id: "t-2",
        userId: "user-1",
        collection: "deadline",
        objectId: "dl-gone",
        deletedAt: new Date("2026-08-11T00:00:00Z"),
      },
      {
        id: "t-3",
        userId: "user-1",
        collection: "task",
        objectId: "task-gone",
        deletedAt: new Date("2026-08-12T00:00:00Z"),
      },
    ];
    const prisma = {
      userDocument: { findMany: jest.fn().mockResolvedValue([]) },
      userDeadline: { findMany: jest.fn().mockResolvedValue([]) },
      userTask: { findMany: jest.fn().mockResolvedValue([]) },
      documentInsight: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      syncTombstone: {
        findMany: jest.fn().mockResolvedValue(tombstones),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ now: SERVER_NOW }]),
    } as unknown as PrismaService;
    const service = new AppSyncService(prisma);

    const result = await service.delta("user-1", { limit: 200 });

    expect(result.deleted).toEqual({
      documents: ["doc-gone"],
      deadlines: ["dl-gone"],
      tasks: ["task-gone"],
    });
    // The tombstone leg advances its own cursor position.
    expect(parseSyncCursor(result.nextCursor).deleted).toEqual({
      t: "2026-08-12T00:00:00.000Z",
      id: "t-3",
    });
  });

  it("accepts a pre-tombstone cursor without a deleted position", () => {
    // Stored client cursors minted before tombstones existed must keep
    // working — the deleted position defaults to null (full tombstone leg).
    const raw = Buffer.from(
      JSON.stringify({
        v: 1,
        docs: null,
        deadlines: null,
        tasks: null,
        insights: null,
      }),
      "utf8",
    ).toString("base64url");
    expect(parseSyncCursor(raw).deleted).toBeNull();
  });

  it("flags resync and restarts from scratch when the cursor outlived tombstone retention", async () => {
    const { service, prisma } = buildService({ docRows: [] });
    const stale = encodeSyncCursor({
      v: 1,
      docs: { t: "2025-01-01T00:00:00.000Z", id: "" },
      deadlines: { t: "2025-01-01T00:00:00.000Z", id: "" },
      tasks: { t: "2025-01-01T00:00:00.000Z", id: "" },
      insights: { t: "2025-01-01T00:00:00.000Z", id: "" },
      deleted: { t: "2025-01-01T00:00:00.000Z", id: "" },
    });

    const result = await service.delta("user-1", {
      cursor: stale,
      limit: 200,
    });

    expect(result.resync).toBe(true);
    // The stale cursor is ignored: the docs leg queries without a keyset
    // filter (full pull from scratch).
    expect(prisma.userDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user-1" } }),
    );
  });

  it("does not flag resync for a fresh cursor within retention", async () => {
    const { service } = buildService({ docRows: [] });

    const result = await service.delta("user-1", { limit: 200 });

    expect(result.resync).toBe(false);
  });

  it("prunes tombstones at most once an hour across polls", async () => {
    const { service, prisma } = buildService({ docRows: [] });
    // The shared builder queues only two one-shot insight answers; the
    // third delta below needs the persistent default.
    (prisma.documentInsight.findMany as jest.Mock).mockResolvedValue([]);
    const deleteMany = prisma.syncTombstone.deleteMany as jest.Mock;

    await service.delta("user-1", { limit: 200 });
    await service.delta("user-1", { limit: 200 });
    await service.delta("user-1", { limit: 200 });

    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it("round-trips an opaque cursor through the parser", () => {    const raw = encodeSyncCursor({
      v: 1,
      docs: { t: "2026-08-01T00:00:00.000Z", id: "doc-9" },
      deadlines: null,
      tasks: null,
      insights: null,
      deleted: null,
    });
    // Base64url is query-safe: no +/= that needs percent-encoding.
    expect(raw).not.toMatch(/[+/=]/);
    expect(parseSyncCursor(raw).docs).toEqual({
      t: "2026-08-01T00:00:00.000Z",
      id: "doc-9",
    });
  });

  it("clamps the limit to SYNC_MAX_LIMIT", async () => {
    const { service, prisma } = buildService();

    await service.delta("user-1", { limit: 100_000 });

    expect(prisma.userDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 500 }),
    );
  });

  it("hasMore is true when a collection fills the page", async () => {
    const fullPage = Array.from({ length: 2 }, (_, i) => ({
      ...docRow,
      id: `doc-${i}`,
    }));
    const { service } = buildService({ docRows: fullPage });

    const result = await service.delta("user-1", { limit: 2 });

    expect(result.hasMore).toBe(true);
  });

  it("hasMore is true when the recent-insights leg fills the page", async () => {
    const recent = Array.from({ length: 2 }, (_, i) => ({
      ...insightRow,
      id: `insight-${i}`,
    }));
    const { service } = buildService({ insightRecent: recent });

    const result = await service.delta("user-1", { limit: 2 });

    expect(result.hasMore).toBe(true);
  });

  it("attaches insights to their document and scopes the query by user", async () => {
    const { service, prisma } = buildService({ insightForDocs: [insightRow] });

    const result = await service.delta("user-1", { limit: 200 });

    expect(result.documents[0].insights).toEqual([
      {
        id: insightRow.id,
        documentId: insightRow.documentId,
        kind: insightRow.kind,
        severity: insightRow.severity,
        title: insightRow.title,
        body: insightRow.body,
        createdAt: insightRow.createdAt,
      },
    ]);
    const insightMock = prisma.documentInsight.findMany as jest.Mock;
    expect(insightMock).toHaveBeenCalledTimes(2);
    expect(insightMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-1" }),
      }),
    );
  });

  it("every query is userId-scoped", async () => {
    const { service, prisma } = buildService();

    await service.delta("user-42", { limit: 10 });

    expect(prisma.userDocument.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-42" }),
      }),
    );
    expect(prisma.userDeadline.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-42" }),
      }),
    );
    expect(prisma.userTask.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: "user-42" }),
      }),
    );
  });
});
