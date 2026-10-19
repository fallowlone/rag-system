import { BadRequestException } from "@nestjs/common";
import { AppDocumentsService } from "./app-documents.service";
import { DocumentQualityService } from "./document-quality.service";
import { DocumentAnalysisService } from "./document-analysis.service";
import { PrismaService } from "../prisma/prisma.service";
import { UserMemoryService } from "../memory/user-memory.service";
import { DocvaultService } from "../rag/docvault.service";
import { InjectionClassifierService } from "../rag/injection-classifier.service";
import { AppDocumentIngestInput } from "./app-api.types";
import { extractionFingerprint } from "./extraction-hash";

function futureIso(daysAhead: number): string {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  return date.toISOString().slice(0, 10);
}

function buildInput(): AppDocumentIngestInput {
  return {
    sourceHash: "a".repeat(64),
    fileName: "bescheid.pdf",
    title: "Bewilligungsbescheid Bürgergeld",
    sender: "Jobcenter Berlin",
    category: "jobcenter",
    facts: [
      { content: "Bewilligung ab 01.10.2026", importance: "high" },
    ],
    deadlines: [
      {
        label: "Widerspruch einlegen",
        date: futureIso(30),
        kind: "Widerspruchsfrist",
      },
      // Past date — must be filtered out by the 365-day validation window
      { label: "Veraltet", date: "2020-01-01" },
    ],
    obligations: ["Nachweis einreichen"],
    addresses: [{ purpose: "Jobcenter", address: "Musterstr. 1, 10115 Berlin" }],
    amounts: [{ label: "Bürgergeld", value: "563", currency: "EUR" }],
    tags: ["Bürgergeld"],
    isActive: true,
  };
}

describe("AppDocumentsService", () => {
  function buildService(options?: {
    verdict?: string;
    classifyError?: boolean;
    created?: boolean;
    storedFullText?: string;
    docvaultIngestError?: boolean;
    analysisError?: boolean;
    existingInsights?: { id: string }[];
    // Row counts seen on the duplicate path: 0 simulates an interrupted
    // first ingest (heal), >0 a complete one (no-op).
    storedFacts?: number;
    storedDeadlines?: number;
    storedChunks?: number;
    storedLinks?: number;
    /** null = a row that predates extractionHash; a string = a stored one. */
    storedExtractionHash?: string | null;
    doomedDeadlines?: { id: string }[];
  }) {
    const classify = options?.classifyError
      ? jest.fn().mockRejectedValue(new Error("classifier down"))
      : jest.fn().mockResolvedValue(options?.verdict ?? "SAFE");

    const prisma = {
      userDeadline: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(options?.storedDeadlines ?? 1),
      },
      documentTag: {
        // createMany + read-back, not upsert: upsert in a Promise.all races
        // itself on @@unique([userId, name]) when two documents are imported
        // with the same new tag.
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findMany: jest.fn().mockResolvedValue([{ id: "tag-1" }]),
      },
      documentTagLink: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        count: jest.fn().mockResolvedValue(options?.storedLinks ?? 1),
        findMany: jest.fn().mockResolvedValue([]),
      },
      userDocument: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      userMemory: {
        count: jest.fn().mockResolvedValue(options?.storedFacts ?? 1),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      lawChunk: {
        count: jest.fn().mockResolvedValue(options?.storedChunks ?? 1),
      },
      documentInsight: {
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      syncTombstone: {
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      // Interactive transaction: the re-ingest path replaces a document's
      // derived rows atomically. The fake hands the callback the same mock,
      // which is enough to assert what was deleted and rewritten.
      $transaction: jest.fn(),
    } as unknown as PrismaService;
    (prisma as unknown as { $transaction: jest.Mock }).$transaction.mockImplementation(
      (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
    );
    (
      prisma as unknown as { userDeadline: { deleteMany: jest.Mock; findMany: jest.Mock } }
    ).userDeadline.deleteMany = jest.fn().mockResolvedValue({ count: 0 });
    (
      prisma as unknown as { userDeadline: { findMany: jest.Mock } }
    ).userDeadline.findMany = jest
      .fn()
      .mockResolvedValue(options?.doomedDeadlines ?? []);
    (
      prisma as unknown as { documentTagLink: { deleteMany: jest.Mock } }
    ).documentTagLink.deleteMany = jest.fn().mockResolvedValue({ count: 0 });

    const userMemory = {
      createDocument: jest.fn().mockResolvedValue({
        doc: {
          id: "doc-1",
          fullText: options?.storedFullText ?? null,
          // Duplicate-path tests mean "the same file AND the same
          // extraction", so the stored fingerprint has to match what the
          // service computes from the payload — otherwise every one of them
          // would (correctly) take the re-extraction branch instead.
          extractionHash:
            options?.storedExtractionHash === undefined
              ? extractionFingerprint(buildInput())
              : options.storedExtractionHash,
        },
        created: options?.created ?? true,
      }),
      rememberBatch: jest.fn().mockResolvedValue([]),
      deleteDocument: jest.fn().mockResolvedValue(true),
    } as unknown as UserMemoryService;

    const docvault = {
      ingest: options?.docvaultIngestError
        ? jest.fn().mockRejectedValue(new Error("embedding service down"))
        : jest.fn().mockResolvedValue({ chunkCount: 3, docvaultId: "doc-1" }),
      delete: jest.fn().mockResolvedValue({ deleted: 3, docvaultId: "doc-1" }),
    } as unknown as DocvaultService;

    const injectionClassifier = {
      classify,
    } as unknown as InjectionClassifierService;

    const analysis = {
      forgetRefusal: jest.fn(),
      analyzeAndStore: options?.analysisError
        ? jest.fn().mockRejectedValue(new Error("Anthropic down"))
        : jest
            .fn()
            .mockResolvedValue(
              options?.existingInsights ?? [
                {
                  id: "insight-1",
                  documentId: "doc-1",
                  kind: "next_step",
                  severity: "high",
                  title: "Widerspruch einlegen",
                  body: "Frist beachten.",
                  createdAt: new Date("2026-09-05"),
                },
              ],
            ),
      listForDocument: jest
        .fn()
        .mockResolvedValue(options?.existingInsights ?? []),
      listForUser: jest.fn().mockResolvedValue([]),
    } as unknown as DocumentAnalysisService;

    const service = new AppDocumentsService(
      prisma,
      userMemory,
      docvault,
      injectionClassifier,
      new DocumentQualityService(),
      analysis,
    );
    return { service, prisma, userMemory, docvault, classify, analysis };
  }

  /**
   * The index text buildIndexText currently derives from buildInput(). Read
   * from the real code path rather than duplicated as a literal, so a format
   * change updates every "already up to date" expectation at once.
   */
  async function currentIndexText(): Promise<string> {
    const probe = buildService();
    await probe.service.ingest("user-1", buildInput());
    return (probe.docvault.ingest as jest.Mock).mock.calls[0][0].text as string;
  }

  describe("ingest", () => {
    it("stores facts, valid deadlines, tags and the docvault index on the happy path", async () => {
      const { service, userMemory, docvault, prisma } = buildService();
      const result = await service.ingest("user-1", buildInput());

      // Quality gate: the fixture has no summary, no docDate and one past
      // deadline — medium(10) + low(5) + medium(10) = 75.
      expect(result.quality.score).toBe(75);
      expect(result.quality.issues.map((i) => i.code)).toEqual([
        "missing_summary",
        "no_dates",
        "unusable_deadlines",
      ]);
      expect(result).toEqual({
        documentId: "doc-1",
        created: true,
        factsStored: 1,
        deadlinesCreated: 1,
        quality: result.quality,
        insights: [
          {
            id: "insight-1",
            documentId: "doc-1",
            kind: "next_step",
            severity: "high",
            title: "Widerspruch einlegen",
            body: "Frist beachten.",
            createdAt: new Date("2026-09-05"),
          },
        ],
        suggestedTasks: ["Nachweis einreichen"],
      });

      // App-path columns are set on the document row
      expect(userMemory.createDocument).toHaveBeenCalledWith(
        "user-1",
        "a".repeat(64),
        "jobcenter",
        1,
        "bescheid.pdf",
        expect.any(String),
        undefined,
        true,
        null,
        {
          title: "Bewilligungsbescheid Bürgergeld",
          docDate: null,
          status: "active",
          appSource: true,
          // Identifies the extraction (not the file) so a later re-extraction
          // of the same document can be told apart from a re-upload.
          extractionHash: extractionFingerprint(buildInput()),
        },
      );

      // Facts persisted as memories
      expect(userMemory.rememberBatch).toHaveBeenCalledWith(
        "user-1",
        ["Bewilligung ab 01.10.2026"],
        "document",
        "a".repeat(64),
        "doc-1",
      );


      // Past deadline filtered; only the future one stored, scoped to the user
      expect(prisma.userDeadline.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            userId: "user-1",
            sourceType: "document",
            sourceId: "doc-1",
            label: "Widerspruchsfrist: Widerspruch einlegen",
          }),
        ],
      });

      // Docvault index receives the sanitized index text, owner-scoped
      expect(docvault.ingest).toHaveBeenCalledWith(
        expect.objectContaining({
          docvaultId: "doc-1",
          ownerUserId: "user-1",
          category: "jobcenter",
        }),
      );
    });

    it("indexes the obligations, so 'what must I do?' is answerable", async () => {
      const { service, docvault, userMemory } = buildService();

      await service.ingest("user-1", buildInput());

      // One string feeds three consumers: UserDocument.fullText, the
      // docvault chunks, and DocumentAnalysisService's prompt. Dropping
      // obligations from it silently removed them from all three.
      const indexed = (docvault.ingest as jest.Mock).mock.calls[0][0]
        .text as string;
      expect(indexed).toContain("Pflichten:");
      expect(indexed).toContain("Nachweis einreichen");

      const storedFullText = (userMemory.createDocument as jest.Mock).mock
        .calls[0][5] as string;
      expect(storedFullText).toContain("Nachweis einreichen");
    });

    it("rejects the whole payload when the classifier returns INJECTION", async () => {
      const { service, userMemory } = buildService({ verdict: "INJECTION" });
      await expect(service.ingest("user-1", buildInput())).rejects.toThrow(
        BadRequestException,
      );
      expect(userMemory.createDocument).not.toHaveBeenCalled();
    });

    it("fails open when the classifier is unavailable", async () => {
      const { service, userMemory } = buildService({ classifyError: true });
      const result = await service.ingest("user-1", buildInput());
      expect(result.created).toBe(true);
      expect(userMemory.createDocument).toHaveBeenCalled();
    });

    it("leaves a complete duplicate alone (no rewrite of any step)", async () => {
      // "Complete" now includes the stored index text, not just the row
      // counts: a document whose fullText predates a format change is not
      // complete, however many chunks it has.
      const { service, userMemory, docvault, prisma } = buildService({
        created: false,
        storedFullText: await currentIndexText(),
      });
      const result = await service.ingest("user-1", buildInput());
      expect(result.created).toBe(false);
      expect(result.factsStored).toBe(0);
      expect(result.deadlinesCreated).toBe(0);
      expect(userMemory.rememberBatch).not.toHaveBeenCalled();
      expect(docvault.ingest).not.toHaveBeenCalled();
      expect(prisma.userDeadline.createMany).not.toHaveBeenCalled();
    });

    it("re-derives a duplicate's index text when the stored one predates a format change", async () => {
      // The payload is never persisted server-side, so there is no SQL
      // backfill for documents stored before `Pflichten:` was added — only
      // the device still holds the extraction JSON. Re-deriving on mismatch
      // is what lets a re-push repair them at all.
      const { service, docvault, prisma } = buildService({
        created: false,
        storedFullText: "Titel: Bewilligungsbescheid\nKategorie: jobcenter",
      });

      await service.ingest("user-1", buildInput());

      expect(docvault.ingest).toHaveBeenCalled();
      const reindexed = (docvault.ingest as jest.Mock).mock.calls[0][0]
        .text as string;
      expect(reindexed).toContain("Pflichten:");
      expect(prisma.userDocument.updateMany).toHaveBeenCalledWith({
        // userId-scoped, never update-by-id alone.
        where: { id: "doc-1", userId: "user-1" },
        data: { fullText: reindexed },
      });
    });

    it("leaves a duplicate's index alone when the stored text already matches", async () => {
      // Re-embedding every re-push would burn local inference for nothing.
      const { service, docvault, prisma } = buildService({
        created: false,
        storedFullText: await currentIndexText(),
      });

      await service.ingest("user-1", buildInput());

      expect(docvault.ingest).not.toHaveBeenCalled();
      expect(prisma.userDocument.updateMany).not.toHaveBeenCalled();
    });

    it("still returns the task suggestions on the duplicate path", async () => {
      // Obligations are persisted nowhere: this response is the only channel
      // that ever carries them. A lost response plus a client retry lands
      // here, so returning [] permanently costs the user every suggestion.
      const { service } = buildService({ created: false });

      const result = await service.ingest("user-1", buildInput());

      expect(result.created).toBe(false);
      expect(result.suggestedTasks).toEqual(["Nachweis einreichen"]);
    });

    it("heals a duplicate left hollow by an interrupted first ingest", async () => {
      // All step counts read 0 — every missing step must be re-run, and the
      // reported counts must reflect what was healed.
      const { service, userMemory, docvault, prisma } = buildService({
        created: false,
        storedFacts: 0,
        storedDeadlines: 0,
        storedChunks: 0,
        storedLinks: 0,
      });
      const result = await service.ingest("user-1", buildInput());
      expect(result.created).toBe(false);
      expect(result.factsStored).toBe(1);
      expect(result.deadlinesCreated).toBe(1);
      expect(userMemory.rememberBatch).toHaveBeenCalledWith(
        "user-1",
        ["Bewilligung ab 01.10.2026"],
        "document",
        "a".repeat(64),
        "doc-1",
      );
      expect(prisma.userDeadline.createMany).toHaveBeenCalled();
      expect(docvault.ingest).toHaveBeenCalled();
    });

    it("completes the ingest even when the docvault index fails", async () => {
      const { service } = buildService({ docvaultIngestError: true });
      const result = await service.ingest("user-1", buildInput());
      expect(result.created).toBe(true);
    });

    it("completes the ingest with empty insights when the analysis fails", async () => {
      const { service, analysis } = buildService({ analysisError: true });
      const result = await service.ingest("user-1", buildInput());
      expect(result.created).toBe(true);
      expect(result.insights).toEqual([]);
      expect(analysis.analyzeAndStore).toHaveBeenCalled();
    });

    it("returns stored insights for a duplicate without re-paying the model", async () => {
      const stored = [{ id: "insight-9" }];
      const { service, analysis } = buildService({
        created: false,
        existingInsights: stored,
      });
      const result = await service.ingest("user-1", buildInput());
      expect(result.created).toBe(false);
      expect(result.insights).toEqual(stored);
      // analyzeAndStore short-circuits on stored rows — one call, no LLM.
      expect(analysis.analyzeAndStore).toHaveBeenCalledTimes(1);
      expect(analysis.listForDocument).not.toHaveBeenCalled();
    });
  });

  describe("delete", () => {
    it("deletes the document and its docvault chunks", async () => {
      const { service, userMemory, docvault } = buildService();
      expect(await service.delete("user-1", "doc-1")).toBe(true);
      expect(userMemory.deleteDocument).toHaveBeenCalledWith("user-1", "doc-1");
      expect(docvault.delete).toHaveBeenCalledWith("doc-1", "user-1");
    });

    it("returns false without docvault cleanup when the document is unknown", async () => {
      const { service, userMemory, docvault } = buildService();
      (userMemory.deleteDocument as jest.Mock).mockResolvedValue(false);
      expect(await service.delete("user-1", "missing")).toBe(false);
      expect(docvault.delete).not.toHaveBeenCalled();
    });
  });

  describe("list", () => {
    it("caps the document page instead of reading the table unbounded", async () => {
      const { service, prisma } = buildService();

      await service.list("user-1");

      expect(prisma.userDocument.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 500 }),
      );
      expect(prisma.documentTagLink.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 5000 }),
      );
    });
  });

describe("AppDocumentsService re-extraction", () => {
  /** Same file, different extraction — a better model, a fixed prompt. */
  function improvedInput(): AppDocumentIngestInput {
    return {
      ...buildInput(),
      title: "Bewilligungsbescheid Bürgergeld (korrigiert)",
      summary: "Neue Zusammenfassung aus einer besseren Extraktion.",
      facts: [
        { content: "Bewilligung ab 01.10.2026", importance: "high" },
        { content: "Regelbedarf 563 EUR monatlich", importance: "high" },
      ],
      isActive: false,
    };
  }

  it("rebuilds the document instead of treating it as a duplicate", async () => {
    // The whole point of F1: sourceHash keys the FILE, so before the
    // fingerprint existed a re-extracted document arrived as a duplicate and
    // healDuplicate only ever filled in gaps — facts, deadlines, insights and
    // every scalar field kept the old extraction forever.
    const { service, prisma, userMemory, analysis } = buildService({
      created: false,
      storedExtractionHash: extractionFingerprint(buildInput()),
    });

    const result = await service.ingest("user-1", improvedInput());

    // Old derived rows are cleared...
    expect(prisma.userMemory.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", documentId: "doc-1" },
    });
    expect(prisma.userDeadline.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", sourceId: "doc-1" },
    });
    // ...including insights, which are computed FROM the extraction and are
    // therefore invalid once it changes.
    expect(prisma.documentInsight.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1", documentId: "doc-1" },
    });
    // ...and the memo that would otherwise suppress the new analysis.
    expect(analysis.forgetRefusal).toHaveBeenCalledWith("doc-1");

    // ...and the document's own fields follow the new extraction.
    expect(prisma.userDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "doc-1", userId: "user-1" },
        data: expect.objectContaining({
          title: "Bewilligungsbescheid Bürgergeld (korrigiert)",
          summary: "Neue Zusammenfassung aus einer besseren Extraktion.",
          isActive: false,
          status: "closed",
          factsCount: 2,
          extractionHash: extractionFingerprint(improvedInput()),
        }),
      }),
    );

    // ...and the new facts are stored, which the old duplicate branch only
    // did when the stored count was exactly zero.
    expect(userMemory.rememberBatch).toHaveBeenCalledWith(
      "user-1",
      ["Bewilligung ab 01.10.2026", "Regelbedarf 563 EUR monatlich"],
      "document",
      expect.any(String),
      "doc-1",
    );

    expect(result.created).toBe(false);
    expect(result.factsStored).toBe(2);
  });

  it("tombstones the deadlines it removes so synced devices drop them too", async () => {
    const { service, prisma } = buildService({
      created: false,
      storedExtractionHash: extractionFingerprint(buildInput()),
      doomedDeadlines: [{ id: "dl-old-1" }, { id: "dl-old-2" }],
    });

    await service.ingest("user-1", improvedInput());

    expect(prisma.syncTombstone.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          { userId: "user-1", collection: "deadline", objectId: "dl-old-1" },
          { userId: "user-1", collection: "deadline", objectId: "dl-old-2" },
        ],
        skipDuplicates: true,
      }),
    );
  });

  it("rebuilds a row that predates the fingerprint column, exactly once", async () => {
    // NULL means "unknown", and those rows are precisely the ones holding a
    // stale extraction — so the first re-push of each rebuilds.
    const { service, prisma } = buildService({
      created: false,
      storedExtractionHash: null,
    });

    await service.ingest("user-1", buildInput());

    expect(prisma.userMemory.deleteMany).toHaveBeenCalled();
    expect(prisma.userDocument.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          extractionHash: extractionFingerprint(buildInput()),
        }),
      }),
    );
  });

  it("leaves an unchanged re-push alone — no delete, no re-analysis", async () => {
    const { service, prisma, analysis } = buildService({
      created: false,
      storedExtractionHash: extractionFingerprint(buildInput()),
    });

    await service.ingest("user-1", buildInput());

    expect(prisma.userMemory.deleteMany).not.toHaveBeenCalled();
    expect(prisma.documentInsight.deleteMany).not.toHaveBeenCalled();
    expect(analysis.forgetRefusal).not.toHaveBeenCalled();
  });
});
});

describe("extractionFingerprint", () => {
  it("is stable for an identical payload", () => {
    expect(extractionFingerprint(buildInput())).toBe(
      extractionFingerprint(buildInput()),
    );
  });

  it("ignores sourceHash — it identifies the extraction, not the file", () => {
    const a = { ...buildInput(), sourceHash: "a".repeat(64) };
    const b = { ...buildInput(), sourceHash: "b".repeat(64) };
    expect(extractionFingerprint(a)).toBe(extractionFingerprint(b));
  });

  it("changes when any stored field of the extraction changes", () => {
    const base = extractionFingerprint(buildInput());
    const variants: AppDocumentIngestInput[] = [
      { ...buildInput(), title: "anders" },
      { ...buildInput(), summary: "anders" },
      { ...buildInput(), category: "bank" },
      { ...buildInput(), isActive: false },
      { ...buildInput(), tags: ["anders"] },
      { ...buildInput(), obligations: ["anders"] },
      {
        ...buildInput(),
        facts: [{ content: "Bewilligung ab 01.10.2026", importance: "low" }],
      },
    ];
    for (const variant of variants) {
      expect(extractionFingerprint(variant)).not.toBe(base);
    }
  });

  it("treats a reordering as a different extraction", () => {
    const input = buildInput();
    const reordered = {
      ...input,
      deadlines: [...input.deadlines].reverse(),
    };
    expect(extractionFingerprint(reordered)).not.toBe(
      extractionFingerprint(input),
    );
  });
});
