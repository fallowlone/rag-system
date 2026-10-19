import { ConflictException } from "@nestjs/common";
import { MemoryTranslationService } from "./memory-translation.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmbeddingService } from "../ingestion/embedding.service";

const ORIGINAL_ENV = process.env;

function germanResponse(texts: string[]) {
  return {
    usage: { input_tokens: 10, output_tokens: 10 },
    content: [{ type: "text", text: JSON.stringify(texts) }],
  };
}

function buildService(opts: {
  findManyImpl: jest.Mock;
  createImpl?: jest.Mock;
  embedImpl?: jest.Mock;
}) {
  process.env = { ...ORIGINAL_ENV, ANTHROPIC_API_KEY: "test-key" };
  const prisma = {
    userMemory: { findMany: opts.findManyImpl },
    $executeRaw: jest.fn().mockResolvedValue(1),
  } as unknown as PrismaService;
  const embedding = {
    embed:
      opts.embedImpl ??
      jest.fn().mockImplementation((texts: string[]) =>
        Promise.resolve(texts.map(() => [0.1, 0.2])),
      ),
  } as unknown as EmbeddingService;

  const service = new MemoryTranslationService(prisma, embedding);
  const create =
    opts.createImpl ??
    jest.fn().mockResolvedValue(germanResponse(["deutsch"]));
  (service as unknown as { anthropic: unknown }).anthropic = {
    messages: { create },
  };
  return { service, prisma, embedding, create };
}

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe("MemoryTranslationService overlap guard", () => {
  it("rejects a second concurrent run and releases the lock afterwards", async () => {
    let resolvePage!: (rows: Array<{ id: string; content: string }>) => void;
    const findMany = jest
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Array<{ id: string; content: string }>>((resolve) => {
            resolvePage = resolve;
          }),
      )
      .mockResolvedValue([]);
    const { service } = buildService({ findManyImpl: findMany });

    const first = service.retranslateAll();
    await expect(service.retranslateAll()).rejects.toThrow(ConflictException);

    resolvePage([]);
    await expect(first).resolves.toEqual({ updated: 0, skipped: 0 });
    // Lock released: a follow-up run works.
    await expect(service.retranslateAll()).resolves.toEqual({
      updated: 0,
      skipped: 0,
    });
  });
});

describe("MemoryTranslationService keyset pagination", () => {
  it("pages through the backlog with cursor/skip/take instead of one unbounded snapshot", async () => {
    const page1 = Array.from({ length: 200 }, (_, i) => ({
      id: `p1-${i}`,
      content: `fact ${i}`,
    }));
    const page2 = [{ id: "p2-0", content: "fact tail" }];
    const findMany = jest
      .fn()
      .mockResolvedValueOnce(page1)
      .mockResolvedValueOnce(page2)
      .mockResolvedValue([]);
    // Echo back one German string per input text, whatever the batch size.
    const create = jest.fn().mockImplementation((args: {
      messages: Array<{ content: string }>;
    }) => {
      const inputs = JSON.parse(args.messages[0]?.content ?? "[]") as unknown[];
      return Promise.resolve(
        germanResponse(inputs.map((_, i) => `deutsch ${i}`)),
      );
    });
    const { service } = buildService({ findManyImpl: findMany, createImpl: create });

    const result = await service.retranslateAll();

    expect(result).toEqual({ updated: 201, skipped: 0 });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 200 }),
    );
    // A full page continues after its last id; the short tail page ends the run.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: "p1-199" },
        skip: 1,
        take: 200,
      }),
    );
    expect(findMany).toHaveBeenCalledTimes(2);
    expect(
      (service as unknown as { prisma: PrismaService }).prisma.$executeRaw,
    ).toHaveBeenCalledTimes(201);
  });

  it("skips the batch without writing when the embedding count mismatches", async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([{ id: "id-1", content: "fact one" }])
      .mockResolvedValue([]);
    const { service, prisma } = buildService({
      findManyImpl: findMany,
      embedImpl: jest.fn().mockResolvedValue([]),
    });

    const result = await service.retranslateAll();

    expect(result).toEqual({ updated: 0, skipped: 1 });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("skips the batch without writing when the LLM call fails", async () => {
    const findMany = jest
      .fn()
      .mockResolvedValueOnce([{ id: "id-1", content: "fact one" }])
      .mockResolvedValue([]);
    const { service, prisma } = buildService({
      findManyImpl: findMany,
      createImpl: jest.fn().mockRejectedValue(new Error("429")),
    });

    const result = await service.retranslateAll();

    expect(result).toEqual({ updated: 0, skipped: 1 });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});
