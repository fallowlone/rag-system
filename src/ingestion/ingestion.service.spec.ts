import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { IngestionService } from "./ingestion.service";
import { LawFetcherService } from "./law-fetcher.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmbeddingService } from "./embedding.service";

describe("IngestionService.ingestLaw checksum skip", () => {
  it("does not embed or write chunks when fetchLaw reports skipped: true", async () => {
    const prisma = {
      law: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: "bgb", checksum: "abc123" }),
      },
      $transaction: jest.fn(),
    } as unknown as PrismaService;

    const fetcher = {
      fetchLaw: jest.fn().mockResolvedValue({
        chunks: [],
        checksum: "abc123",
        skipped: true,
      }),
    } as unknown as LawFetcherService;

    const embedding = {
      embed: jest.fn(),
    } as unknown as EmbeddingService;

    const service = new IngestionService(prisma, fetcher, embedding);
    const result = await service.ingestLaw("bgb");

    expect(result).toEqual({ lawId: "bgb", chunksInserted: 0, skipped: true });
    expect(embedding.embed).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(fetcher.fetchLaw).toHaveBeenCalledWith({ id: "bgb", checksum: "abc123" });
  });
});

describe("IngestionService.ingestLaw roomId", () => {
  it("writes roomId resolved from lawId into the LawChunk INSERT", async () => {
    const prisma = {
      law: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: "bgb", checksum: "old-checksum" }),
      },
      $transaction: jest.fn(),
    } as unknown as PrismaService;

    const fetcher = {
      fetchLaw: jest.fn().mockResolvedValue({
        chunks: [{ normKey: "§ 1", heading: null, text: "chunk text" }],
        checksum: "new-checksum",
        skipped: false,
      }),
    } as unknown as LawFetcherService;

    const embedding = {
      embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    } as unknown as EmbeddingService;

    interface FakeTx {
      lawChunk: { deleteMany: jest.Mock };
      law: { update: jest.Mock };
      $queryRaw: jest.Mock;
      $executeRaw: jest.Mock;
    }

    const tx: FakeTx = {
      lawChunk: { deleteMany: jest.fn() },
      law: { update: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn(),
    };

    (
      prisma.$transaction as unknown as jest.Mock<
        Promise<void>,
        [(tx: FakeTx) => Promise<void>]
      >
    ).mockImplementation((callback) => callback(tx));

    const service = new IngestionService(prisma, fetcher, embedding);
    const result = await service.ingestLaw("bgb");

    expect(result).toEqual({ lawId: "bgb", chunksInserted: 1, skipped: false });
    expect(tx.lawChunk.deleteMany).toHaveBeenCalledWith({ where: { lawId: "bgb" } });
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);

    const insertSql = tx.$executeRaw.mock.calls[0][0] as Prisma.Sql;
    expect(insertSql.sql).toContain('"roomId"');
    // "bgb" resolves to the mietrecht room via resolveRoomForLaw
    expect(insertSql.values).toContain("mietrecht");
  });

  it("writes local embeddings only into embeddingBge", async () => {
    const prisma = {
      law: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: "bgb", checksum: "old-checksum" }),
      },
      $transaction: jest.fn(),
    } as unknown as PrismaService;
    const fetcher = {
      fetchLaw: jest.fn().mockResolvedValue({
        chunks: [{ normKey: "§ 1", heading: null, text: "chunk text" }],
        checksum: "new-checksum",
        skipped: false,
      }),
    } as unknown as LawFetcherService;
    const embedding = {
      embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    } as unknown as EmbeddingService;
    const tx = {
      lawChunk: { deleteMany: jest.fn() },
      law: { update: jest.fn() },
      $queryRaw: jest.fn().mockResolvedValue([]),
      $executeRaw: jest.fn(),
    };
    (prisma.$transaction as unknown as jest.Mock).mockImplementation(
      (callback: (value: typeof tx) => Promise<void>) => callback(tx),
    );

    await new IngestionService(prisma, fetcher, embedding).ingestLaw("bgb");

    const insertSql = tx.$executeRaw.mock.calls[0][0] as Prisma.Sql;
    expect(insertSql.sql).toContain('"embeddingBge"');
    expect(insertSql.sql).not.toMatch(/\bembedding\b(?!Bge)/);
  });

  it("does not read or preserve legacy embeddings during BGE re-ingest", async () => {
    const prisma = {
      law: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: "bgb", checksum: "old-checksum" }),
      },
      $transaction: jest.fn(),
    } as unknown as PrismaService;
    const fetcher = {
      fetchLaw: jest.fn().mockResolvedValue({
        chunks: [{ normKey: "§ 1", heading: null, text: "chunk text" }],
        checksum: "new-checksum",
        skipped: false,
      }),
    } as unknown as LawFetcherService;
    const embedding = {
      embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    } as unknown as EmbeddingService;
    const tx = {
      lawChunk: { deleteMany: jest.fn() },
      law: { update: jest.fn() },
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn(),
    };
    (prisma.$transaction as unknown as jest.Mock).mockImplementation(
      (callback: (value: typeof tx) => Promise<void>) => callback(tx),
    );

    await new IngestionService(prisma, fetcher, embedding).ingestLaw("bgb");

    const insertSql = tx.$executeRaw.mock.calls[0][0] as Prisma.Sql;
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(insertSql.values).toContain("[0.1,0.2,0.3]");
  });
});

describe("IngestionService overlap guards", () => {  function buildServiceWithDeferredPrisma() {
    let resolveFindMany!: (rows: Array<{ id: string }>) => void;
    const prisma = {
      law: {
        findMany: jest.fn(
          () =>
            new Promise<Array<{ id: string }>>((resolve) => {
              resolveFindMany = resolve;
            }),
        ),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: "bgb", checksum: "old" }),
      },
      $transaction: jest.fn(),
    } as unknown as PrismaService;
    const fetcher = {
      fetchLaw: jest.fn(),
    } as unknown as LawFetcherService;
    const embedding = {
      embed: jest.fn(),
    } as unknown as EmbeddingService;
    const service = new IngestionService(prisma, fetcher, embedding);
    return {
      service,
      finishListLaws: () => resolveFindMany([{ id: "bgb" }]),
    };
  }

  it("rejects a second ingestAll while one is running, then accepts after it finishes", async () => {
    const { service, finishListLaws } = buildServiceWithDeferredPrisma();

    const first = service.ingestAll();
    expect(service.ingestAllInProgress).toBe(true);
    await expect(service.ingestAll()).rejects.toThrow(ConflictException);

    finishListLaws();
    await first;
    expect(service.ingestAllInProgress).toBe(false);
  });

  it("rejects a second ingestLaw for the same law while it is running", async () => {
    let resolveFetch!: (result: unknown) => void;
    const prisma = {
      law: {
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: "bgb", checksum: "old" }),
      },
      $transaction: jest.fn(),
    } as unknown as PrismaService;
    const fetcher = {
      fetchLaw: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    } as unknown as LawFetcherService;
    const embedding = {
      embed: jest.fn(),
    } as unknown as EmbeddingService;
    const service = new IngestionService(prisma, fetcher, embedding);

    const first = service.ingestLaw("bgb");
    expect(service.isLawInProgress("bgb")).toBe(true);
    expect(service.isLawInProgress("sgb-ii")).toBe(false);
    await expect(service.ingestLaw("bgb")).rejects.toThrow(ConflictException);

    resolveFetch({ chunks: [], checksum: "new", skipped: true });
    await first;
    expect(service.isLawInProgress("bgb")).toBe(false);
  });

  it("releases the ingestAll lock when the run fails", async () => {
    const prisma = {
      law: {
        findMany: jest.fn().mockRejectedValue(new Error("db down")),
      },
    } as unknown as PrismaService;
    const service = new IngestionService(
      prisma,
      {} as unknown as LawFetcherService,
      {} as unknown as EmbeddingService,
    );

    await expect(service.ingestAll()).rejects.toThrow("db down");
    expect(service.ingestAllInProgress).toBe(false);
  });
});

describe("IngestionService.ingestAll empty counter", () => {
  it("counts zero-chunk laws as empty, not processed", async () => {
    const prisma = {
      law: {
        findMany: jest.fn().mockResolvedValue([{ id: "bgb" }]),
        findUniqueOrThrow: jest
          .fn()
          .mockResolvedValue({ id: "bgb", checksum: "old" }),
      },
      $transaction: jest.fn(),
    } as unknown as PrismaService;
    const fetcher = {
      fetchLaw: jest.fn().mockResolvedValue({
        chunks: [],
        checksum: "new",
        skipped: false,
      }),
    } as unknown as LawFetcherService;
    const embedding = {
      embed: jest.fn(),
    } as unknown as EmbeddingService;

    const result = await new IngestionService(
      prisma,
      fetcher,
      embedding,
    ).ingestAll();

    expect(result).toEqual({
      processed: 0,
      skipped: 0,
      failed: 0,
      totalChunks: 0,
      empty: 1,
    });
  });
});
