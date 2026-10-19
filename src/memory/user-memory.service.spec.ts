import { UserMemoryService } from "./user-memory.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmbeddingService } from "../ingestion/embedding.service";
import { DeadlineService } from "../deadlines/deadline.service";
import { ConversationService } from "../conversation/conversation.service";
import { CacheService } from "../cache/cache.service";
import { DocumentJobPayload } from "../documents/queue/document-job.types";
import { NightlyBatchPayload } from "../batch/batch.types";

describe("UserMemoryService.forgetAll", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: "test-key" };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  interface FakeJob<T> {
    id: string;
    data: T;
    remove: jest.Mock<Promise<void>, []>;
  }

  function makeJob<T>(id: string, data: T, removeImpl?: () => Promise<void>): FakeJob<T> {
    return {
      id,
      data,
      remove: jest.fn(removeImpl ?? (() => Promise.resolve())),
    };
  }

  function buildService(options?: {
    counts?: number[];
    docvaultDeleted?: number;
    documentJobs?: FakeJob<DocumentJobPayload>[];
    nightlyJobs?: FakeJob<NightlyBatchPayload>[];
    conversationClearHistory?: jest.Mock;
    cacheDel?: jest.Mock;
    cacheSetJson?: jest.Mock;
    cacheDelByPrefix?: jest.Mock;
    documentQueueGetJobs?: jest.Mock;
    nightlyQueueGetJobs?: jest.Mock;
  }) {
    const counts = options?.counts ?? [3, 1, 2, 5, 4, 1, 1, 2, 1, 3, 1];
    const documentJobs = options?.documentJobs ?? [];
    const nightlyJobs = options?.nightlyJobs ?? [];

    const prisma = {
      userMemory: { deleteMany: jest.fn() },
      userDocument: {
        deleteMany: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      userDeadline: {
        deleteMany: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      conversationLog: { deleteMany: jest.fn() },
      userDiary: { deleteMany: jest.fn() },
      conflictPushState: { deleteMany: jest.fn() },
      batchJobState: { deleteMany: jest.fn() },
      userTask: {
        deleteMany: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      deviceSession: { deleteMany: jest.fn() },
      documentTag: { deleteMany: jest.fn() },
      documentInsight: { deleteMany: jest.fn() },
      syncTombstone: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      // The 12th transaction op is the raw LawChunk docvault delete, which
      // resolves to a row count (not a { count } payload).
      $executeRaw: jest.fn().mockResolvedValue(options?.docvaultDeleted ?? 0),
      $transaction: jest
        .fn()
        .mockImplementation(() =>
          Promise.resolve([
            ...counts.map((count) => ({ count })),
            options?.docvaultDeleted ?? 0,
          ]),
        ),
    } as unknown as PrismaService;
    const embedding = {} as EmbeddingService;
    const deadlines = {} as DeadlineService;

    const conversation = {
      clearHistory:
        options?.conversationClearHistory ?? jest.fn().mockResolvedValue(undefined),
    } as unknown as ConversationService;

    const cache = {
      del: options?.cacheDel ?? jest.fn().mockResolvedValue(undefined),
      setJson:
        options?.cacheSetJson ?? jest.fn().mockResolvedValue(undefined),
      delByPrefix:
        options?.cacheDelByPrefix ?? jest.fn().mockResolvedValue(0),
    } as unknown as CacheService;

    const documentQueue = {
      getJobs:
        options?.documentQueueGetJobs ??
        jest.fn().mockResolvedValue(documentJobs),
    } as unknown as import("bullmq").Queue<DocumentJobPayload>;

    const nightlyBatchQueue = {
      getJobs:
        options?.nightlyQueueGetJobs ??
        jest.fn().mockResolvedValue(nightlyJobs),
    } as unknown as import("bullmq").Queue<NightlyBatchPayload>;

    const service = new UserMemoryService(
      prisma,
      embedding,
      deadlines,
      conversation,
      cache,
      documentQueue,
      nightlyBatchQueue,
    );

    return {
      service,
      prisma,
      conversation,
      cache,
      documentQueue,
      nightlyBatchQueue,
    };
  }

  it("deletes all per-user tables plus docvault vectors in a single transaction and sums their counts", async () => {
    const { service, prisma } = buildService({
      counts: [3, 1, 2, 5, 4, 1, 1, 2, 1, 3, 1],
      docvaultDeleted: 4,
    });

    const result = await service.forgetAll("user-1");

    expect(result.deletedCount).toBe(28);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    const ops = (prisma.$transaction as jest.Mock).mock.calls[0][0];
    // 11 typed deletes + raw docvault delete + tombstone createMany.
    expect(ops).toHaveLength(13);
    expect(prisma.userMemory.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    expect(prisma.userDocument.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    expect(prisma.userDeadline.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    expect(prisma.conversationLog.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    expect(prisma.userDiary.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    expect(prisma.conflictPushState.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    expect(prisma.batchJobState.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    expect(prisma.documentInsight.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    // Docvault vectors are owner-scoped and deleted by raw SQL in the same
    // transaction (pgvector column) — parameterized by userId, never unscoped.
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [strings, boundUserId] = (prisma.$executeRaw as jest.Mock).mock
      .calls[0] as unknown as [string[], string];
    expect(strings.join("")).toContain('"LawChunk"');
    expect(strings.join("")).toContain("'docvault'");
    expect(boundUserId).toBe("user-1");
  });

  it("counts deleted docvault vectors in deletedCount", async () => {
    const { service } = buildService({
      counts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      docvaultDeleted: 4,
    });

    const result = await service.forgetAll("user-1");

    expect(result.deletedCount).toBe(4);
  });

  it("forgetAll tombstones every synced row inside the same transaction", async () => {
    const { service, prisma } = buildService();
    (prisma.userDocument.findMany as jest.Mock).mockResolvedValue([
      { id: "doc-1" },
    ]);
    (prisma.userDeadline.findMany as jest.Mock).mockResolvedValue([
      { id: "dl-1" },
    ]);
    (prisma.userTask.findMany as jest.Mock).mockResolvedValue([
      { id: "task-1" },
    ]);

    await service.forgetAll("user-1");

    expect(prisma.syncTombstone.createMany).toHaveBeenCalledWith({
      data: [
        { userId: "user-1", collection: "document", objectId: "doc-1" },
        { userId: "user-1", collection: "deadline", objectId: "dl-1" },
        { userId: "user-1", collection: "task", objectId: "task-1" },
      ],
      skipDuplicates: true,
    });
    // The tombstone write joins the atomic sweep (not a separate call).
    const ops = (prisma.$transaction as jest.Mock).mock.calls[0][0];
    expect(ops).toHaveLength(13);
  });

  it("returns 0 deletedCount when the user has no rows anywhere", async () => {
    const { service } = buildService({ counts: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });

    const result = await service.forgetAll("user-2");

    expect(result.deletedCount).toBe(0);
  });

  it("happy path: clears conversation history, removes only this user's queue jobs, and deletes letter pending keys, with no failures reported", async () => {
    const documentJobs = [
      makeJob<DocumentJobPayload>("doc-1", {
        userId: "user-1",
        chatId: "chat-1",
        fileId: "file-1",
        fileName: "a.pdf",
        caption: null,
        lang: "de",
        statusMsgId: null,
        sourceHash: null,
        category: null,
      }),
      makeJob<DocumentJobPayload>("doc-2", {
        userId: "other-user",
        chatId: "chat-2",
        fileId: "file-2",
        fileName: "b.pdf",
        caption: null,
        lang: "de",
        statusMsgId: null,
        sourceHash: null,
        category: null,
      }),
    ];
    const nightlyJobs = [
      makeJob<NightlyBatchPayload>("nightly-1", {
        userId: "user-1",
        processedDateIso: new Date().toISOString(),
      }),
    ];

    const { service, conversation, cache, documentQueue, nightlyBatchQueue } =
      buildService({ documentJobs, nightlyJobs });

    const result = await service.forgetAll("user-1");

    expect(conversation.clearHistory).toHaveBeenCalledWith("user-1");
    expect(documentQueue.getJobs).toHaveBeenCalledWith([
      "waiting",
      "delayed",
      "completed",
      "failed",
    ]);
    expect(nightlyBatchQueue.getJobs).toHaveBeenCalledWith([
      "waiting",
      "delayed",
      "completed",
      "failed",
    ]);

    // Only the matching user's job was removed, the other user's job untouched.
    expect(documentJobs[0]!.remove).toHaveBeenCalledTimes(1);
    expect(documentJobs[1]!.remove).not.toHaveBeenCalled();
    expect(nightlyJobs[0]!.remove).toHaveBeenCalledTimes(1);

    expect(cache.del).toHaveBeenCalledWith("letter_style_pending:user-1");
    expect(cache.del).toHaveBeenCalledWith("letter_pdf_pending:user-1");
    expect(cache.del).toHaveBeenCalledWith("lang:user-1");
    expect(cache.del).toHaveBeenCalledWith("sumlock:user-1");
    expect(cache.del).toHaveBeenCalledTimes(4);

    expect(result.documentJobsRemoved).toBe(1);
    expect(result.nightlyJobsRemoved).toBe(1);
    expect(result.failures).toEqual([]);
  });

  it("forgetAll erases the nightly block summaries, which hold the user's own conversation text", async () => {
    // batchsum:{userId}:{date} caches LLM-written summaries of the user's
    // conversations for 36 h. It is dated, so there is no single key to
    // delete — an erase that only removes the known key names leaves the
    // erased content readable for a day and a half.
    const cacheDelByPrefix = jest.fn().mockResolvedValue(2);
    const { service } = buildService({ cacheDelByPrefix });

    const result = await service.forgetAll("user-1");

    expect(cacheDelByPrefix).toHaveBeenCalledWith("batchsum:user-1:");
    expect(result.failures).toEqual([]);
  });

  it("forgetAll reports a batch-summary deletion failure instead of claiming full erasure", async () => {
    const cacheDelByPrefix = jest
      .fn()
      .mockRejectedValue(new Error("redis down"));
    const { service } = buildService({ cacheDelByPrefix });

    const result = await service.forgetAll("user-1");

    // Partial erasure must surface: the caller tells the user their data is
    // gone, so a silent miss here is a false GDPR confirmation.
    expect(result.failures).toContain("batch-summaries");
  });

  it("does not remove other users' jobs from either queue", async () => {
    const documentJobs = [
      makeJob<DocumentJobPayload>("doc-1", {
        userId: "someone-else",
        chatId: "chat-1",
        fileId: "file-1",
        fileName: null,
        caption: null,
        lang: "de",
        statusMsgId: null,
        sourceHash: null,
        category: null,
      }),
    ];
    const nightlyJobs = [
      makeJob<NightlyBatchPayload>("nightly-1", {
        userId: "someone-else",
        processedDateIso: new Date().toISOString(),
      }),
    ];

    const { service } = buildService({ documentJobs, nightlyJobs });

    const result = await service.forgetAll("user-1");

    expect(documentJobs[0]!.remove).not.toHaveBeenCalled();
    expect(nightlyJobs[0]!.remove).not.toHaveBeenCalled();
    expect(result.documentJobsRemoved).toBe(0);
    expect(result.nightlyJobsRemoved).toBe(0);
    expect(result.failures).toEqual([]);
  });

  it("a Redis conversation-history failure does not block Postgres, BullMQ, or letter-key cleanup", async () => {
    const conversationClearHistory = jest
      .fn()
      .mockRejectedValue(new Error("Redis down"));
    const documentJobs = [
      makeJob<DocumentJobPayload>("doc-1", {
        userId: "user-1",
        chatId: "chat-1",
        fileId: "file-1",
        fileName: null,
        caption: null,
        lang: "de",
        statusMsgId: null,
        sourceHash: null,
        category: null,
      }),
    ];

    const { service, cache, prisma } = buildService({
      conversationClearHistory,
      documentJobs,
    });

    const result = await service.forgetAll("user-1");

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(documentJobs[0]!.remove).toHaveBeenCalledTimes(1);
    expect(cache.del).toHaveBeenCalledWith("letter_style_pending:user-1");
    expect(cache.del).toHaveBeenCalledWith("letter_pdf_pending:user-1");
    expect(result.documentJobsRemoved).toBe(1);
    expect(result.failures).toEqual(["conversation-history"]);
  });

  it("a BullMQ queue enumeration failure does not block Redis or the other queue's cleanup", async () => {
    const documentQueueGetJobs = jest
      .fn()
      .mockRejectedValue(new Error("Redis connection lost"));
    const nightlyJobs = [
      makeJob<NightlyBatchPayload>("nightly-1", {
        userId: "user-1",
        processedDateIso: new Date().toISOString(),
      }),
    ];

    const { service, conversation, cache } = buildService({
      documentQueueGetJobs,
      nightlyJobs,
    });

    const result = await service.forgetAll("user-1");

    expect(conversation.clearHistory).toHaveBeenCalledWith("user-1");
    expect(nightlyJobs[0]!.remove).toHaveBeenCalledTimes(1);
    expect(cache.del).toHaveBeenCalledWith("letter_style_pending:user-1");
    expect(result.documentJobsRemoved).toBe(0);
    expect(result.nightlyJobsRemoved).toBe(1);
    expect(result.failures).toEqual(["document-queue"]);
  });

  it("a letter-pending cache deletion failure is isolated and reported, without blocking other steps", async () => {
    const cacheDel = jest
      .fn()
      .mockImplementation((key: string) =>
        key === "letter_style_pending:user-1"
          ? Promise.reject(new Error("Redis timeout"))
          : Promise.resolve(undefined),
      );

    const { service, conversation } = buildService({ cacheDel });

    const result = await service.forgetAll("user-1");

    expect(conversation.clearHistory).toHaveBeenCalledWith("user-1");
    expect(cacheDel).toHaveBeenCalledWith("letter_pdf_pending:user-1");
    expect(result.failures).toEqual(["letter_style_pending"]);
  });

  it("a lang-cache deletion failure is isolated and reported, without blocking other steps", async () => {
    const cacheDel = jest
      .fn()
      .mockImplementation((key: string) =>
        key === "lang:user-1"
          ? Promise.reject(new Error("Redis timeout"))
          : Promise.resolve(undefined),
      );

    const { service, conversation } = buildService({ cacheDel });

    const result = await service.forgetAll("user-1");

    expect(conversation.clearHistory).toHaveBeenCalledWith("user-1");
    expect(cacheDel).toHaveBeenCalledWith("letter_style_pending:user-1");
    expect(cacheDel).toHaveBeenCalledWith("letter_pdf_pending:user-1");
    expect(result.failures).toEqual(["lang-cache"]);
  });

  it("reports multiple failures together when several steps fail independently", async () => {
    const conversationClearHistory = jest
      .fn()
      .mockRejectedValue(new Error("Redis down"));
    const nightlyQueueGetJobs = jest
      .fn()
      .mockRejectedValue(new Error("queue unreachable"));

    const { service } = buildService({
      conversationClearHistory,
      nightlyQueueGetJobs,
    });

    const result = await service.forgetAll("user-1");

    expect(result.failures).toEqual(
      expect.arrayContaining(["conversation-history", "nightly-batch-queue"]),
    );
    expect(result.failures).toHaveLength(2);
  });

  it("a single job's remove() failure still removes the rest AND surfaces the queue in failures", async () => {
    const documentJobs = [
      makeJob<DocumentJobPayload>(
        "doc-1",
        {
          userId: "user-1",
          chatId: "chat-1",
          fileId: "file-1",
          fileName: null,
          caption: null,
          lang: "de",
          statusMsgId: null,
          sourceHash: null,
          category: null,
        },
        () => Promise.reject(new Error("job already removed")),
      ),
      makeJob<DocumentJobPayload>("doc-2", {
        userId: "user-1",
        chatId: "chat-2",
        fileId: "file-2",
        fileName: null,
        caption: null,
        lang: "de",
        statusMsgId: null,
        sourceHash: null,
        category: null,
      }),
    ];

    const { service } = buildService({ documentJobs });

    const result = await service.forgetAll("user-1");

    // The failing job does not stop the sweep — the second job is still removed.
    expect(documentJobs[0]!.remove).toHaveBeenCalledTimes(1);
    expect(documentJobs[1]!.remove).toHaveBeenCalledTimes(1);
    expect(result.documentJobsRemoved).toBe(1);
    // But a job left behind keeps the user's payload in Redis, so the
    // partial removal must be reflected in failures — not reported as success.
    expect(result.failures).toEqual(["document-queue"]);
  });

  it("plants the forget-marker so in-flight jobs skip their writes", async () => {
    const cacheSetJson = jest.fn().mockResolvedValue(undefined);
    const { service, cache } = buildService({ cacheSetJson });

    const result = await service.forgetAll("user-1");

    expect(cacheSetJson).toHaveBeenCalledWith(
      "forget:user-1",
      { at: expect.any(String) },
      3_600,
    );
    expect(result.failures).not.toContain("forget-marker");
    expect(cache.setJson).toBe(cacheSetJson);
  });

  it("surfaces a forget-marker write failure instead of claiming full success", async () => {
    const { service } = buildService({
      cacheSetJson: jest.fn().mockRejectedValue(new Error("Redis down")),
    });

    const result = await service.forgetAll("user-1");

    expect(result.failures).toEqual(["forget-marker"]);
  });
});

describe("UserMemoryService.getUserLanguage / setUserLanguage caching", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: "test-key" };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  function buildService(options?: {
    cacheGet?: jest.Mock;
    cacheSet?: jest.Mock;
    findFirst?: jest.Mock;
  }) {
    const findFirst = options?.findFirst ?? jest.fn().mockResolvedValue(null);
    const prisma = {
      userMemory: { findFirst },
    } as unknown as PrismaService;
    const embedding = {} as EmbeddingService;
    const deadlines = {} as DeadlineService;
    const conversation = {} as ConversationService;
    const cache = {
      get: options?.cacheGet ?? jest.fn().mockResolvedValue(null),
      set: options?.cacheSet ?? jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;
    const documentQueue = {} as import("bullmq").Queue<DocumentJobPayload>;
    const nightlyBatchQueue = {} as import("bullmq").Queue<NightlyBatchPayload>;

    const service = new UserMemoryService(
      prisma,
      embedding,
      deadlines,
      conversation,
      cache,
      documentQueue,
      nightlyBatchQueue,
    );

    return { service, cache, findFirst };
  }

  it("returns the cached language without touching Postgres on a cache hit", async () => {
    const cacheGet = jest.fn().mockResolvedValue("de");
    const { service, findFirst } = buildService({ cacheGet });

    const lang = await service.getUserLanguage("user-1");

    expect(lang).toBe("de");
    expect(cacheGet).toHaveBeenCalledWith("lang:user-1");
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("returns null (not a cache miss) for the no-preference sentinel, without touching Postgres", async () => {
    const cacheGet = jest.fn().mockResolvedValue("__none__");
    const { service, findFirst } = buildService({ cacheGet });

    const lang = await service.getUserLanguage("user-1");

    expect(lang).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("on a cache miss, queries Postgres and caches the result", async () => {
    const cacheSet = jest.fn().mockResolvedValue(undefined);
    const findFirst = jest.fn().mockResolvedValue({ content: "language:ru" });
    const { service } = buildService({ cacheSet, findFirst });

    const lang = await service.getUserLanguage("user-1");

    expect(lang).toBe("ru");
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(cacheSet).toHaveBeenCalledWith("lang:user-1", "ru", 86_400);
  });

  it("on a cache miss with no stored preference, caches the none-sentinel instead of re-querying every time", async () => {
    const cacheSet = jest.fn().mockResolvedValue(undefined);
    const { service } = buildService({ cacheSet });

    const lang = await service.getUserLanguage("user-1");

    expect(lang).toBeNull();
    expect(cacheSet).toHaveBeenCalledWith("lang:user-1", "__none__", 86_400);
  });

  it("setUserLanguage writes through to the cache immediately", async () => {
    const cacheSet = jest.fn().mockResolvedValue(undefined);
    const { service } = buildService({ cacheSet });
    (service as unknown as { remember: jest.Mock }).remember = jest
      .fn()
      .mockResolvedValue({ id: "mem-1", createdAt: new Date() });
    (
      service as unknown as { prisma: { userMemory: { deleteMany: jest.Mock } } }
    ).prisma.userMemory.deleteMany = jest.fn().mockResolvedValue(undefined);

    await service.setUserLanguage("user-1", "en");

    expect(cacheSet).toHaveBeenCalledWith("lang:user-1", "en", 86_400);
  });

  it("setUserLanguage converges concurrent duplicates to the latest row, never zero", async () => {
    const { service } = buildService({});
    const now = new Date();
    (service as unknown as { remember: jest.Mock }).remember = jest
      .fn()
      .mockResolvedValue({ id: "mem-new", createdAt: now });
    const deleteMany = jest.fn().mockResolvedValue({ count: 1 });
    (
      service as unknown as { prisma: { userMemory: { deleteMany: jest.Mock } } }
    ).prisma.userMemory.deleteMany = deleteMany;

    await service.setUserLanguage("user-1", "de");

    // Pre-delete (all) + post-cleanup (strictly older): the survivor is the
    // just-inserted row; a second concurrent caller converges the same way.
    expect(deleteMany).toHaveBeenCalledTimes(2);
    expect(deleteMany).toHaveBeenLastCalledWith({
      where: {
        userId: "user-1",
        type: "preference",
        content: { startsWith: "language:" },
        createdAt: { lt: now },
      },
    });
  });
});

describe("UserMemoryService.deleteDocument / forget cleanup ordering", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: "test-key" };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  function buildService(options?: {
    cleanup?: jest.Mock;
    docDeleteCount?: number;
    memoryDeleteCount?: number;
    forgetRow?: { type: string; content: string } | null;
  }) {
    const cleanup =
      options?.cleanup ?? jest.fn().mockResolvedValue(undefined);
    const docDeleteMany = jest
      .fn()
      .mockResolvedValue({ count: options?.docDeleteCount ?? 1 });
    const memoryDeleteMany = jest
      .fn()
      .mockResolvedValue({ count: options?.memoryDeleteCount ?? 1 });
    const memoryFindFirst = jest
      .fn()
      .mockResolvedValue(options?.forgetRow ?? null);
    const deadlineFindMany = jest.fn().mockResolvedValue([]);
    const tombstoneCreateMany = jest.fn().mockResolvedValue({ count: 0 });
    const cacheDel = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      userDocument: { deleteMany: docDeleteMany },
      userMemory: { deleteMany: memoryDeleteMany, findFirst: memoryFindFirst },
      userDeadline: { findMany: deadlineFindMany },
      syncTombstone: { createMany: tombstoneCreateMany },
    } as unknown as PrismaService;
    const deadlines = {
      deleteDeadlinesBySource: cleanup,
    } as unknown as DeadlineService;
    const cache = { del: cacheDel } as unknown as CacheService;
    const service = new UserMemoryService(
      prisma,
      {} as EmbeddingService,
      deadlines,
      {} as ConversationService,
      cache,
      {} as import("bullmq").Queue<DocumentJobPayload>,
      {} as import("bullmq").Queue<NightlyBatchPayload>,
    );
    return {
      service,
      cleanup,
      docDeleteMany,
      memoryDeleteMany,
      memoryFindFirst,
      deadlineFindMany,
      tombstoneCreateMany,
      cacheDel,
    };
  }

  it("deleteDocument cleans deadlines before deleting the row (retry-safe order)", async () => {
    const { service, cleanup, docDeleteMany } = buildService();

    await expect(service.deleteDocument("user-1", "doc-1")).resolves.toBe(true);

    expect(cleanup).toHaveBeenCalledWith("doc-1", "user-1");
    expect(docDeleteMany).toHaveBeenCalledWith({
      where: { id: "doc-1", userId: "user-1" },
    });
    expect(cleanup.mock.invocationCallOrder[0]).toBeLessThan(
      docDeleteMany.mock.invocationCallOrder[0]!,
    );
  });

  it("deleteDocument propagates a cleanup failure without deleting the row", async () => {
    const cleanup = jest.fn().mockRejectedValue(new Error("db error"));
    const { service, docDeleteMany } = buildService({ cleanup });

    await expect(service.deleteDocument("user-1", "doc-1")).rejects.toThrow(
      "db error",
    );
    expect(docDeleteMany).not.toHaveBeenCalled();
  });

  it("forget cleans deadlines before deleting the row and reports a miss", async () => {
    const { service, cleanup, memoryDeleteMany } = buildService({
      memoryDeleteCount: 0,
    });

    await expect(service.forget("user-1", "mem-1")).resolves.toBe(false);

    expect(cleanup).toHaveBeenCalledWith("mem-1", "user-1");
    expect(cleanup.mock.invocationCallOrder[0]).toBeLessThan(
      memoryDeleteMany.mock.invocationCallOrder[0]!,
    );
  });

  it("forget clears the lang cache when forgetting the language preference", async () => {
    const { service, cacheDel } = buildService({
      forgetRow: { type: "preference", content: "language:ru" },
    });

    await expect(service.forget("user-1", "mem-lang")).resolves.toBe(true);

    expect(cacheDel).toHaveBeenCalledWith("lang:user-1");
  });

  it("forget leaves the lang cache alone for ordinary memories", async () => {
    const { service, cacheDel } = buildService({
      forgetRow: { type: "fact", content: "Miete 800 EUR" },
    });

    await expect(service.forget("user-1", "mem-1")).resolves.toBe(true);

    expect(cacheDel).not.toHaveBeenCalled();
  });

  it("deleteDocument tombstones the document and its deadlines", async () => {
    const { service, deadlineFindMany, tombstoneCreateMany } = buildService();
    deadlineFindMany.mockResolvedValue([{ id: "dl-1" }, { id: "dl-2" }]);

    await expect(service.deleteDocument("user-1", "doc-1")).resolves.toBe(true);

    expect(tombstoneCreateMany).toHaveBeenCalledWith({
      data: [
        { userId: "user-1", collection: "document", objectId: "doc-1" },
        { userId: "user-1", collection: "deadline", objectId: "dl-1" },
        { userId: "user-1", collection: "deadline", objectId: "dl-2" },
      ],
      skipDuplicates: true,
    });
  });

  it("deleteDocument records no tombstone when nothing was deleted", async () => {
    const { service, tombstoneCreateMany } = buildService({
      docDeleteCount: 0,
    });

    await expect(service.deleteDocument("user-1", "missing")).resolves.toBe(
      false,
    );

    expect(tombstoneCreateMany).not.toHaveBeenCalled();
  });
});

describe("UserMemoryService preference filtering", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: "test-key" };
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    jest.restoreAllMocks();
  });

  function buildRecallService(findManyRows: unknown[]) {
    const findMany = jest.fn().mockResolvedValue(findManyRows);
    const prisma = {
      userMemory: { findMany, findFirst: jest.fn(), deleteMany: jest.fn() },
    } as unknown as PrismaService;
    const service = new UserMemoryService(
      prisma,
      {} as EmbeddingService,
      {} as DeadlineService,
      {} as ConversationService,
      {} as CacheService,
      {} as import("bullmq").Queue<DocumentJobPayload>,
      {} as import("bullmq").Queue<NightlyBatchPayload>,
    );
    return { service, findMany };
  }

  it("recall excludes machine-state preference rows from the query", async () => {
    const rows = [
      {
        id: "m1",
        type: "fact",
        content: "Miete 800 EUR",
        createdAt: new Date("2026-08-01T00:00:00Z"),
      },
    ];
    const { service, findMany } = buildRecallService(rows);

    const result = await service.recall("user-1", "Miete");

    expect(result).toHaveLength(1);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ type: { not: "preference" } }),
      }),
    );
  });

  it("list excludes machine-state preference rows", async () => {
    const rows = [
      {
        id: "m1",
        userId: "user-1",
        type: "fact",
        content: "Miete 800 EUR",
        contentOriginal: null,
        createdAt: new Date("2026-08-01T00:00:00Z"),
      },
    ];
    const { service, findMany } = buildRecallService(rows);

    await service.list("user-1");

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ type: { not: "preference" } }),
      }),
    );
  });
});
