import { Job, RateLimitError } from "bullmq";
import Anthropic from "@anthropic-ai/sdk";
import { Prisma } from "@prisma/client";
import { NightlyBatchProcessor } from "./nightly-batch.processor";
import { PrismaService } from "../prisma/prisma.service";
import { EmbeddingService } from "../ingestion/embedding.service";
import { CacheService } from "../cache/cache.service";
import { BatchLlmService } from "./batch-llm.service";
import { NightlyBatchPayload } from "./batch.types";

describe("NightlyBatchProcessor — existing-facts pass-through", () => {
  function buildProcessor(options?: {
    existingFacts?: Array<{ content: string }>;
    extractFactsMock?: jest.Mock;
  }) {
    const userMemoryFindMany = jest
      .fn()
      .mockResolvedValue(options?.existingFacts ?? []);

    const prisma = {
      batchJobState: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      conversationLog: {
        findMany: jest.fn().mockResolvedValue([
          {
            role: "user",
            content: "Ich habe Bürgergeld beantragt.",
            createdAt: new Date("2026-01-01T10:00:00Z"),
          },
        ]),
      },
      userMemory: { findMany: userMemoryFindMany },
      $executeRaw: jest.fn().mockResolvedValue(undefined),
      $transaction: jest.fn().mockImplementation(async (cb: unknown) => {
        if (typeof cb === "function") {
          const tx = { $queryRaw: jest.fn().mockResolvedValue([]), $executeRaw: jest.fn() };
          return cb(tx);
        }
        return Promise.all(cb as Promise<unknown>[]);
      }),
    } as unknown as PrismaService;

    const embedding = {
      embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    } as unknown as EmbeddingService;

    const cache = {
      getJson: jest.fn().mockResolvedValue(null),
      setJson: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;

    const llm = {
      summarizeBlock: jest.fn().mockResolvedValue({
        summary: "User asked about Bürgergeld.",
        startedAt: new Date("2026-01-01T10:00:00Z"),
        endedAt: new Date("2026-01-01T10:05:00Z"),
        messageCount: 1,
      }),
      writeDiary: jest.fn().mockResolvedValue(""),
      extractFacts: options?.extractFactsMock ?? jest.fn().mockResolvedValue([]),
    } as unknown as BatchLlmService;

    const processor = new NightlyBatchProcessor(prisma, embedding, llm, cache);

    return { processor, prisma, llm, cache, userMemoryFindMany };
  }

  function makeJob(attemptsMade = 0): Job<NightlyBatchPayload> {
    return {
      data: {
        userId: "user-1",
        processedDateIso: "2026-01-01T00:00:00.000Z",
      },
      attemptsMade,
    } as Job<NightlyBatchPayload>;
  }

  it("queries today's active facts for the user and passes their content to extractFacts", async () => {
    const extractFactsMock = jest.fn().mockResolvedValue([]);
    const { processor, userMemoryFindMany } = buildProcessor({
      existingFacts: [
        { content: "Nutzer hat Bürgergeld beantragt." },
        { content: "Nutzer wohnt in Berlin." },
      ],
      extractFactsMock,
    });

    await processor.process(makeJob());

    expect(userMemoryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          type: "fact",
          status: "active",
        }),
        select: { content: true },
      }),
    );

    expect(extractFactsMock).toHaveBeenCalledWith(
      expect.any(Array),
      ["Nutzer hat Bürgergeld beantragt.", "Nutzer wohnt in Berlin."],
    );
  });

  it("passes an empty array to extractFacts when no facts were extracted today yet", async () => {
    const extractFactsMock = jest.fn().mockResolvedValue([]);
    const { processor } = buildProcessor({
      existingFacts: [],
      extractFactsMock,
    });

    await processor.process(makeJob());

    expect(extractFactsMock).toHaveBeenCalledWith(expect.any(Array), []);
  });
});

describe("NightlyBatchProcessor.insertFactMemories (parallel ANN lookups)", () => {
  function buildProcessor(options: {
    extractFactsMock: jest.Mock;
    queryRawResults: Array<Array<{ id: string; similarity: number }>>;
  }) {
    const embedMock = jest
      .fn()
      .mockImplementation((texts: string[]) =>
        Promise.resolve(texts.map(() => [0.1, 0.2, 0.3])),
      );

    let callIndex = 0;
    const queryRawMock = jest.fn().mockImplementation(() => {
      const result = options.queryRawResults[callIndex] ?? [];
      callIndex += 1;
      return Promise.resolve(result);
    });
    const executeRawMock = jest.fn().mockResolvedValue(undefined);

    const prisma = {
      batchJobState: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      conversationLog: {
        findMany: jest.fn().mockResolvedValue([
          { role: "user", content: "msg", createdAt: new Date("2026-01-01T10:00:00Z") },
        ]),
      },
      userMemory: { findMany: jest.fn().mockResolvedValue([]) },
      $executeRaw: jest.fn().mockResolvedValue(undefined),
      $transaction: jest.fn().mockImplementation(async (cb: unknown) => {
        if (typeof cb === "function") {
          const tx = { $queryRaw: queryRawMock, $executeRaw: executeRawMock };
          return cb(tx);
        }
        return Promise.all(cb as Promise<unknown>[]);
      }),
    } as unknown as PrismaService;

    const embedding = { embed: embedMock } as unknown as EmbeddingService;

    const cache = {
      getJson: jest.fn().mockResolvedValue(null),
      setJson: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;

    const llm = {
      summarizeBlock: jest.fn().mockResolvedValue({
        summary: "summary",
        startedAt: new Date("2026-01-01T10:00:00Z"),
        endedAt: new Date("2026-01-01T10:05:00Z"),
        messageCount: 1,
      }),
      writeDiary: jest.fn().mockResolvedValue(""),
      extractFacts: options.extractFactsMock,
    } as unknown as BatchLlmService;

    const processor = new NightlyBatchProcessor(prisma, embedding, llm, cache);
    return { processor, executeRawMock, queryRawMock };
  }

  function makeJob(attemptsMade = 0): Job<NightlyBatchPayload> {
    return {
      data: { userId: "user-1", processedDateIso: "2026-01-01T00:00:00.000Z" },
      attemptsMade,
    } as Job<NightlyBatchPayload>;
  }

  it("runs one ANN lookup per fact and inserts every fact as active when none are near-duplicates", async () => {
    const extractFactsMock = jest
      .fn()
      .mockResolvedValue(["Fact A", "Fact B", "Fact C"]);
    const { processor, executeRawMock, queryRawMock } = buildProcessor({
      extractFactsMock,
      queryRawResults: [[], [], []],
    });

    await processor.process(makeJob());

    expect(queryRawMock).toHaveBeenCalledTimes(3);
    // One INSERT per fact (active path) — no UPDATE/conflict-table writes.
    expect(executeRawMock).toHaveBeenCalledTimes(3);
  });

  it("skips a fact whose top match is a near-duplicate (>= dedup threshold), still inserts the rest", async () => {
    const extractFactsMock = jest
      .fn()
      .mockResolvedValue(["Duplicate fact", "New fact"]);
    const { processor, executeRawMock } = buildProcessor({
      extractFactsMock,
      queryRawResults: [
        [{ id: "existing-1", similarity: 0.9 }], // >= DEDUP_SIMILARITY_THRESHOLD -> skip
        [], // no match -> insert
      ],
    });

    await processor.process(makeJob());

    // Only the second fact produces a write.
    expect(executeRawMock).toHaveBeenCalledTimes(1);
  });

  it("files a conflict (update existing + insert pending + insert ConflictPushState) for a grey-band match", async () => {
    const extractFactsMock = jest.fn().mockResolvedValue(["Conflicting fact"]);
    const { processor, executeRawMock } = buildProcessor({
      extractFactsMock,
      queryRawResults: [[{ id: "existing-1", similarity: 0.7 }]], // grey band: 0.55-0.85
    });

    await processor.process(makeJob());

    expect(executeRawMock).toHaveBeenCalledTimes(3);
  });
});

describe("NightlyBatchProcessor atomic claim (overlap guard)", () => {
  function buildClaimProcessor(batchJobState: Record<string, jest.Mock>) {
    const prisma = {
      batchJobState: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue(undefined),
        ...batchJobState,
      },
      conversationLog: {
        findMany: jest.fn().mockResolvedValue([
          {
            role: "user",
            content: "msg",
            createdAt: new Date("2026-01-01T10:00:00Z"),
          },
        ]),
      },
      userMemory: { findMany: jest.fn().mockResolvedValue([]) },
      $executeRaw: jest.fn().mockResolvedValue(undefined),
      $transaction: jest.fn().mockImplementation(async (cb: unknown) => {
        if (typeof cb === "function") {
          const tx = {
            $queryRaw: jest.fn().mockResolvedValue([]),
            $executeRaw: jest.fn(),
          };
          return cb(tx);
        }
        return Promise.all(cb as Promise<unknown>[]);
      }),
    } as unknown as PrismaService;
    const embedding = {
      embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    } as unknown as EmbeddingService;
    const cache = {
      getJson: jest.fn().mockResolvedValue(null),
      setJson: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;
    const summarizeBlock = jest.fn().mockResolvedValue({
      summary: "summary",
      startedAt: new Date("2026-01-01T10:00:00Z"),
      endedAt: new Date("2026-01-01T10:05:00Z"),
      messageCount: 1,
    });
    const llm = {
      summarizeBlock,
      writeDiary: jest.fn().mockResolvedValue(""),
      extractFacts: jest.fn().mockResolvedValue([]),
    } as unknown as BatchLlmService;
    const processor = new NightlyBatchProcessor(prisma, embedding, llm, cache);
    return { processor, prisma, summarizeBlock };
  }

  function makeJob(attemptsMade = 0): Job<NightlyBatchPayload> {
    return {
      data: {
        userId: "user-1",
        processedDateIso: "2026-01-01T00:00:00.000Z",
      },
      attemptsMade,
    } as Job<NightlyBatchPayload>;
  }

  it("skips a completed day without touching the pipeline", async () => {
    const { processor, prisma, summarizeBlock } = buildClaimProcessor({
      findUnique: jest.fn().mockResolvedValue({ status: "completed" }),
    });

    await processor.process(makeJob());

    expect(
      (prisma.conversationLog.findMany as jest.Mock),
    ).not.toHaveBeenCalled();
    expect(summarizeBlock).not.toHaveBeenCalled();
  });

  it("skips when another run owns the day (first attempt never steals)", async () => {
    const { processor, summarizeBlock } = buildClaimProcessor({
      findUnique: jest.fn().mockResolvedValue({ status: "running" }),
    });

    await processor.process(makeJob(0));

    expect(summarizeBlock).not.toHaveBeenCalled();
  });

  it("reclaims a stale running row on a retry of the same job", async () => {
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const { processor, summarizeBlock } = buildClaimProcessor({
      findUnique: jest.fn().mockResolvedValue({ status: "running" }),
      updateMany,
    });

    await processor.process(makeJob(1));

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "running" }),
      }),
    );
    expect(summarizeBlock).toHaveBeenCalledTimes(1);
  });

  it("skips when the failed→running transition loses the race", async () => {
    const { processor, summarizeBlock } = buildClaimProcessor({
      findUnique: jest.fn().mockResolvedValue({ status: "failed" }),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    });

    await processor.process(makeJob());

    expect(summarizeBlock).not.toHaveBeenCalled();
  });

  it("skips the run without writing when the forget-marker is present (erased)", async () => {
    const prisma = {
      batchJobState: {
        findUnique: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
        update: jest.fn(),
      },
      conversationLog: { findMany: jest.fn() },
      userMemory: { findMany: jest.fn() },
    } as unknown as PrismaService;
    const embedding = {
      embed: jest.fn(),
    } as unknown as EmbeddingService;
    const cache = {
      getJson: jest
        .fn()
        .mockResolvedValue({ at: new Date().toISOString() }),
      setJson: jest.fn(),
    } as unknown as CacheService;
    const summarizeBlock = jest.fn();
    const llm = {
      summarizeBlock,
      writeDiary: jest.fn(),
      extractFacts: jest.fn(),
    } as unknown as BatchLlmService;
    const processor = new NightlyBatchProcessor(prisma, embedding, llm, cache);

    await processor.process(makeJob());

    expect(cache.getJson).toHaveBeenCalledWith("forget:user-1");
    expect(prisma.batchJobState.findUnique).not.toHaveBeenCalled();
    expect(summarizeBlock).not.toHaveBeenCalled();
  });

  it("treats a P2002 on state-row create as a lost overlap race and skips", async () => {    const { processor, summarizeBlock } = buildClaimProcessor({
      create: jest
        .fn()
        .mockRejectedValue(
          new Prisma.PrismaClientKnownRequestError("unique", {
            code: "P2002",
            clientVersion: "test",
          }),
        ),
    });

    await processor.process(makeJob());

    expect(summarizeBlock).not.toHaveBeenCalled();
  });

  it("rate-limits the worker without consuming an attempt on Anthropic 429", async () => {
    const rateLimit = jest.fn().mockResolvedValue(undefined);
    const err = new Error("429 rate limited");
    Object.setPrototypeOf(err, Anthropic.RateLimitError.prototype);
    const { processor } = buildClaimProcessor({});
    // WorkerHost exposes `worker` as a getter-only accessor; stub it.
    Object.defineProperty(processor, "worker", {
      value: { rateLimit },
      configurable: true,
    });
    const summarizeBlock = jest
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue({
        summary: "summary",
        startedAt: new Date("2026-01-01T10:00:00Z"),
        endedAt: new Date("2026-01-01T10:05:00Z"),
        messageCount: 1,
      });
    (
      processor as unknown as {
        llm: { summarizeBlock: jest.Mock };
      }
    ).llm.summarizeBlock = summarizeBlock;

    const rejection = await processor.process(makeJob()).then(
      () => {
        throw new Error("process should have rethrown");
      },
      (err: unknown) => err,
    );
    // BullMQ's RateLimitError is the documented "redeliver without consuming
    // an attempt" signal — assert the exact class, not just the message.
    expect(rejection).toBeInstanceOf(RateLimitError);

    expect(rateLimit).toHaveBeenCalledWith(90_000);
  });
});

describe("NightlyBatchProcessor summaries checkpoint", () => {
  function buildCheckpointProcessor(cacheOpts: {
    getJson: jest.Mock;
    setJson?: jest.Mock;
  }) {
    const prisma = {
      batchJobState: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      conversationLog: {
        findMany: jest.fn().mockResolvedValue([
          {
            role: "user",
            content: "msg",
            createdAt: new Date("2026-01-01T10:00:00Z"),
          },
        ]),
      },
      userMemory: { findMany: jest.fn().mockResolvedValue([]) },
      $executeRaw: jest.fn().mockResolvedValue(undefined),
      $transaction: jest.fn().mockImplementation(async (cb: unknown) => {
        if (typeof cb === "function") {
          const tx = {
            $queryRaw: jest.fn().mockResolvedValue([]),
            $executeRaw: jest.fn(),
          };
          return cb(tx);
        }
        return Promise.all(cb as Promise<unknown>[]);
      }),
    } as unknown as PrismaService;
    const embedding = {
      embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    } as unknown as EmbeddingService;
    const cache = {
      getJson: cacheOpts.getJson,
      setJson: cacheOpts.setJson ?? jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;
    const summarizeBlock = jest.fn().mockResolvedValue({
      summary: "fresh summary",
      startedAt: new Date("2026-01-01T10:00:00Z"),
      endedAt: new Date("2026-01-01T10:05:00Z"),
      messageCount: 1,
    });
    const writeDiary = jest.fn().mockResolvedValue("");
    const llm = {
      summarizeBlock,
      writeDiary,
      extractFacts: jest.fn().mockResolvedValue([]),
    } as unknown as BatchLlmService;
    const processor = new NightlyBatchProcessor(prisma, embedding, llm, cache);
    const job = {
      data: {
        userId: "user-1",
        processedDateIso: "2026-01-01T00:00:00.000Z",
      },
      attemptsMade: 0,
    } as Job<NightlyBatchPayload>;
    return { processor, summarizeBlock, writeDiary, cache, job };
  }

  it("reuses cached summaries on a retry instead of re-paying summarize calls", async () => {
    const getJson = jest.fn().mockImplementation((key: string) => {
      if (key === "forget:user-1") return Promise.resolve(null);
      return Promise.resolve([
        { summary: "cached summary", startedAtIso: "2026-01-01T10:00:00.000Z" },
      ]);
    });
    const { processor, summarizeBlock, writeDiary, job } =
      buildCheckpointProcessor({ getJson });

    await processor.process(job);

    expect(summarizeBlock).not.toHaveBeenCalled();
    expect(getJson).toHaveBeenCalledWith(
      "batchsum:user-1:2026-01-01T00:00:00.000Z",
    );
    expect(writeDiary).toHaveBeenCalledWith([
      expect.objectContaining({ summary: "cached summary" }),
    ]);
  });

  it("falls back to a full summarize pass on a malformed cache entry and rewrites it", async () => {
    const getJson = jest.fn().mockImplementation((key: string) => {
      if (key === "forget:user-1") return Promise.resolve(null);
      return Promise.resolve([{ nope: true }]);
    });
    const setJson = jest.fn().mockResolvedValue(undefined);
    const { processor, summarizeBlock, job } = buildCheckpointProcessor({
      getJson,
      setJson,
    });

    await processor.process(job);

    expect(summarizeBlock).toHaveBeenCalledTimes(1);
    expect(setJson).toHaveBeenCalledWith(
      "batchsum:user-1:2026-01-01T00:00:00.000Z",
      [
        {
          summary: "fresh summary",
          startedAtIso: "2026-01-01T10:00:00.000Z",
        },
      ],
      36 * 60 * 60,
    );
  });

  it("caps the existing-facts context query", async () => {
    const userMemoryFindMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      batchJobState: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue(undefined),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      conversationLog: {
        findMany: jest.fn().mockResolvedValue([
          {
            role: "user",
            content: "msg",
            createdAt: new Date("2026-01-01T10:00:00Z"),
          },
        ]),
      },
      userMemory: { findMany: userMemoryFindMany },
      $executeRaw: jest.fn().mockResolvedValue(undefined),
      $transaction: jest.fn().mockImplementation(async (cb: unknown) => {
        if (typeof cb === "function") {
          const tx = {
            $queryRaw: jest.fn().mockResolvedValue([]),
            $executeRaw: jest.fn(),
          };
          return cb(tx);
        }
        return Promise.all(cb as Promise<unknown>[]);
      }),
    } as unknown as PrismaService;
    const embedding = {
      embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    } as unknown as EmbeddingService;
    const cache = {
      getJson: jest.fn().mockResolvedValue(null),
      setJson: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;
    const llm = {
      summarizeBlock: jest.fn().mockResolvedValue({
        summary: "s",
        startedAt: new Date("2026-01-01T10:00:00Z"),
        endedAt: new Date("2026-01-01T10:00:00Z"),
        messageCount: 1,
      }),
      writeDiary: jest.fn().mockResolvedValue(""),
      extractFacts: jest.fn().mockResolvedValue([]),
    } as unknown as BatchLlmService;
    const processor = new NightlyBatchProcessor(prisma, embedding, llm, cache);

    await processor.process({
      data: {
        userId: "user-1",
        processedDateIso: "2026-01-01T00:00:00.000Z",
      },
      attemptsMade: 0,
    } as Job<NightlyBatchPayload>);

    expect(userMemoryFindMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 50 }),
    );
  });
});

describe("NightlyBatchProcessor stale-run guard", () => {
  function buildProcessor(existing: Record<string, unknown> | null) {
    const updateMany = jest.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      batchJobState: {
        findUnique: jest.fn().mockResolvedValue(existing),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        updateMany,
      },
      conversationLog: { findMany: jest.fn().mockResolvedValue([]) },
      userMemory: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;
    const cache = {
      getJson: jest.fn().mockResolvedValue(null),
      setJson: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;
    const processor = new NightlyBatchProcessor(
      prisma,
      {} as EmbeddingService,
      {} as BatchLlmService,
      cache,
    );
    return { processor, updateMany };
  }

  function job(attemptsMade: number) {
    return {
      data: { userId: "user-1", processedDateIso: "2026-09-09T00:00:00.000Z" },
      attemptsMade,
      // `process` reaches for this only on the rate-limit path.
      id: "job-1",
    } as unknown as Job<NightlyBatchPayload>;
  }

  it("refuses to steal a run that a live worker may still own", async () => {
    // Worker concurrency is 2 and BullMQ redelivers on a stalled lock, so
    // attemptsMade > 0 does NOT prove the previous attempt died. Stealing then
    // gives two runs the same day: double LLM spend, and conflicts fabricated
    // from paraphrase drift between them.
    const { processor, updateMany } = buildProcessor({
      status: "running",
      startedAt: new Date(),
    });

    await processor.process(job(1));

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: "running",
          OR: [
            { startedAt: null },
            { startedAt: { lt: expect.any(Date) } },
          ],
        }),
      }),
    );
    // The guard is the WHERE clause: the row is fresh, so it matches nothing
    // and the mocked count of 0 means the run stands down.
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it("still reclaims a row written before startedAt existed", async () => {
    const { processor, updateMany } = buildProcessor({
      status: "running",
      startedAt: null,
    });

    await processor.process(job(1));

    const where = updateMany.mock.calls[0]![0].where as {
      OR: Array<Record<string, unknown>>;
    };
    expect(where.OR).toContainEqual({ startedAt: null });
  });

  it("does not attempt a steal on the first attempt at all", async () => {
    const { processor, updateMany } = buildProcessor({
      status: "running",
      startedAt: null,
    });

    await processor.process(job(0));

    expect(updateMany).not.toHaveBeenCalled();
  });
});
