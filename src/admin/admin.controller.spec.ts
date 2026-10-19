import { BadRequestException, ConflictException } from "@nestjs/common";
import { AdminController } from "./admin.controller";
import { IngestionService } from "../ingestion/ingestion.service";
import { RetrievalService } from "../rag/retrieval.service";
import { PrismaService } from "../prisma/prisma.service";
import { DocvaultService } from "../rag/docvault.service";
import { MemoryTranslationService } from "../memory/memory-translation.service";

function buildController(overrides?: {
  ingestion?: Partial<IngestionService>;
  retrieval?: Partial<RetrievalService>;
  docvault?: Partial<DocvaultService>;
  memoryTranslation?: Partial<MemoryTranslationService>;
}) {
  const ingestion = {
    ingestAllInProgress: false,
    isLawInProgress: jest.fn().mockReturnValue(false),
    ingestAll: jest.fn().mockResolvedValue({
      processed: 0,
      skipped: 0,
      failed: 0,
      totalChunks: 0,
    }),
    ingestLaw: jest.fn().mockResolvedValue({
      lawId: "bgb",
      chunksInserted: 0,
      skipped: true,
    }),
    ...overrides?.ingestion,
  } as unknown as IngestionService;

  const retrieval = {
    debugSearch: jest.fn().mockResolvedValue([]),
    ...overrides?.retrieval,
  } as unknown as RetrievalService;

  const docvault = {
    ingest: jest.fn().mockResolvedValue({ chunkCount: 1, docvaultId: "doc-1" }),
    status: jest
      .fn()
      .mockResolvedValue({ ingested: true, chunkCount: 1, docvaultId: "doc-1" }),
    delete: jest.fn().mockResolvedValue({ deleted: 1, docvaultId: "doc-1" }),
    query: jest.fn().mockResolvedValue({ answer: "the answer" }),
    ...overrides?.docvault,
  } as unknown as DocvaultService;

  const memoryTranslation = {
    retranslateAll: jest.fn().mockResolvedValue({ updated: 0, skipped: 0 }),
    ...overrides?.memoryTranslation,
  } as unknown as MemoryTranslationService;

  const controller = new AdminController(
    ingestion,
    retrieval,
    {} as unknown as PrismaService,
    docvault,
    memoryTranslation,
  );

  return { controller, ingestion, retrieval, docvault, memoryTranslation };
}

describe("AdminController.retranslate", () => {
  it("delegates to MemoryTranslationService.retranslateAll", async () => {
    const { controller, memoryTranslation } = buildController();
    const result = await controller.retranslate();

    expect(memoryTranslation.retranslateAll).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ updated: 0, skipped: 0 });
  });

  it("propagates the service lock as ConflictException (no second concurrent run)", async () => {
    const { controller } = buildController({
      memoryTranslation: {
        retranslateAll: jest
          .fn()
          .mockRejectedValue(new ConflictException("already running")),
      },
    });

    await expect(controller.retranslate()).rejects.toThrow(ConflictException);
  });
});

describe("AdminController.triggerIngest overlap guard", () => {
  it("starts the background run when idle", () => {
    const { controller, ingestion } = buildController();

    const result = controller.triggerIngest();

    expect(result).toEqual({ message: "Ingestion started in background" });
    expect(ingestion.ingestAll).toHaveBeenCalledTimes(1);
  });

  it("returns 409 without starting a second full run while one is in progress", () => {
    const { controller, ingestion } = buildController({
      ingestion: { ingestAllInProgress: true },
    });

    expect(() => controller.triggerIngest()).toThrow(ConflictException);
    expect(ingestion.ingestAll).not.toHaveBeenCalled();
  });

  it("returns 409 without starting a second per-law run for the same law", () => {
    const { controller, ingestion } = buildController({
      ingestion: {
        isLawInProgress: jest.fn().mockReturnValue(true),
      },
    });

    expect(() => controller.triggerIngestOne("bgb")).toThrow(
      ConflictException,
    );
    expect(ingestion.ingestLaw).not.toHaveBeenCalled();
  });

  it("starts a per-law run for an idle law", () => {
    const { controller, ingestion } = buildController();

    const result = controller.triggerIngestOne("bgb");

    expect(result.message).toContain("bgb");
    expect(ingestion.ingestLaw).toHaveBeenCalledWith("bgb");
  });
});

describe("AdminController.debugSearch validation", () => {
  it("delegates a valid query to RetrievalService.debugSearch", async () => {
    const { controller, retrieval } = buildController();

    await controller.debugSearch("SGB II");

    expect(retrieval.debugSearch).toHaveBeenCalledWith("SGB II", 10);
  });

  it("rejects a missing query without calling the service", async () => {
    const { controller, retrieval } = buildController();

    await expect(controller.debugSearch(undefined)).rejects.toThrow(
      BadRequestException,
    );
    expect(retrieval.debugSearch).not.toHaveBeenCalled();
  });

  it("rejects an oversized query without calling the service", async () => {
    const { controller, retrieval } = buildController();

    await expect(controller.debugSearch("x".repeat(4001))).rejects.toThrow(
      BadRequestException,
    );
    expect(retrieval.debugSearch).not.toHaveBeenCalled();
  });
});

describe("AdminController.docvaultQuery", () => {
  it("delegates the parsed question/ownerUserId/docvaultId to DocvaultService.query", async () => {
    const { controller, docvault } = buildController();

    const result = await controller.docvaultQuery({
      question: "Was ist Bürgergeld?",
      ownerUserId: "user-42",
      docvaultId: "doc-1",
    });

    expect(docvault.query).toHaveBeenCalledWith(
      "Was ist Bürgergeld?",
      "user-42",
      "doc-1",
    );
    expect(result).toEqual({ answer: "the answer" });
  });

  it("rejects with BadRequestException when ownerUserId is missing, without calling the service", async () => {
    const { controller, docvault } = buildController();

    await expect(
      controller.docvaultQuery({ question: "Was ist Bürgergeld?" }),
    ).rejects.toThrow(BadRequestException);
    expect(docvault.query).not.toHaveBeenCalled();
  });

  it("rejects with BadRequestException on a schema-invalid body, without calling the service", async () => {
    const { controller, docvault } = buildController();

    await expect(controller.docvaultQuery({})).rejects.toThrow(
      BadRequestException,
    );
    expect(docvault.query).not.toHaveBeenCalled();
  });

  it("rejects an oversized question without calling the service", async () => {
    const { controller, docvault } = buildController();

    await expect(
      controller.docvaultQuery({
        question: "x".repeat(4001),
        ownerUserId: "user-42",
      }),
    ).rejects.toThrow(BadRequestException);
    expect(docvault.query).not.toHaveBeenCalled();
  });
});

describe("AdminController.docvaultIngest", () => {
  const bodyWithoutOwner = {
    text: "A".repeat(150),
    title: "Test Document",
    source: "docvault",
    docvaultId: "doc-1",
  };

  it("rejects when ownerUserId is missing, without calling the service", async () => {
    const { controller, docvault } = buildController();

    await expect(controller.docvaultIngest(bodyWithoutOwner)).rejects.toThrow(
      BadRequestException,
    );
    expect(docvault.ingest).not.toHaveBeenCalled();
  });

  it("rejects oversized text/title without calling the service", async () => {
    const { controller, docvault } = buildController();
    const oversized = {
      text: "A".repeat(200_001),
      title: "T".repeat(201),
      source: "docvault",
      docvaultId: "doc-1",
      ownerUserId: "user-99",
    };

    await expect(controller.docvaultIngest(oversized)).rejects.toThrow(
      BadRequestException,
    );
    expect(docvault.ingest).not.toHaveBeenCalled();
  });

  it("maps the validated body onto DocvaultService.ingest's input shape", async () => {
    const { controller, docvault } = buildController();
    const body = {
      ...bodyWithoutOwner,
      ownerUserId: "user-99",
      metadata: { category: "mietvertrag" },
    };

    const result = await controller.docvaultIngest(body);

    expect(docvault.ingest).toHaveBeenCalledWith({
      text: body.text,
      title: body.title,
      docvaultId: body.docvaultId,
      ownerUserId: "user-99",
      category: "mietvertrag",
    });
    expect(result).toEqual({ chunkCount: 1, docvaultId: "doc-1" });
  });
});

describe("AdminController.docvaultStatus / docvaultDelete owner scoping", () => {
  it("docvaultStatus rejects when ownerUserId query param is missing, without calling the service", async () => {
    const { controller, docvault } = buildController();

    await expect(
      controller.docvaultStatus("doc-1", undefined),
    ).rejects.toThrow(BadRequestException);
    expect(docvault.status).not.toHaveBeenCalled();
  });

  it("docvaultStatus delegates docvaultId and ownerUserId to the service", async () => {
    const { controller, docvault } = buildController();
    await controller.docvaultStatus("doc-1", "user-42");

    expect(docvault.status).toHaveBeenCalledWith("doc-1", "user-42");
  });

  it("docvaultDelete rejects when ownerUserId query param is missing, without calling the service", async () => {
    const { controller, docvault } = buildController();

    await expect(
      controller.docvaultDelete("doc-1", undefined),
    ).rejects.toThrow(BadRequestException);
    expect(docvault.delete).not.toHaveBeenCalled();
  });

  it("docvaultDelete delegates docvaultId and ownerUserId to the service", async () => {
    const { controller, docvault } = buildController();
    await controller.docvaultDelete("doc-1", "user-42");

    expect(docvault.delete).toHaveBeenCalledWith("doc-1", "user-42");
  });
});
