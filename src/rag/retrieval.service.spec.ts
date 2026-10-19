import { Prisma } from "@prisma/client";
import {
  RetrievalService,
  extractParagraph,
  paragraphFilter,
  isExplicitLawQuery,
  extractLawId,
  composeUnifiedChunks,
  RERANK_MAX_DOCUMENTS,
  UNIFIED_LAW_CANDIDATES,
  UNIFIED_DOC_CANDIDATES,
} from "./retrieval.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmbeddingService } from "../ingestion/embedding.service";
import { PalaceNavigationService } from "./palace-navigation.service";
import { CacheService } from "../cache/cache.service";
import { ChunkSearchResult, RerankingProvider } from "./rag.types";

function rawSqlCall(call: unknown[]): { sql: string; values: unknown[] } {
  const first = call[0];
  if (
    typeof first === "object" &&
    first !== null &&
    "sql" in first &&
    "values" in first
  ) {
    const query = first as Prisma.Sql;
    return { sql: query.sql, values: query.values };
  }

  const strings = first as TemplateStringsArray;
  return { sql: strings.join(""), values: call.slice(1) };
}


function fakeRerankingProvider(
  rerank: jest.Mock = jest.fn().mockResolvedValue([{ index: 0, score: 0.8 }]),
): RerankingProvider {
  return {
    id: "test-reranker",
    rerank,
  };
}

function fakeCache(): CacheService {
  return {
    getJson: jest.fn().mockResolvedValue(null),
    setJson: jest.fn().mockResolvedValue(undefined),
  } as unknown as CacheService;
}

describe("RetrievalService docvault owner scoping (searchUnified)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildService(queryRawMock: jest.Mock) {
    const prisma = {
      $queryRaw: queryRawMock,
    } as unknown as PrismaService;
    const embedding = {
      embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    } as unknown as EmbeddingService;
    const palace = {
      resolveRooms: jest
        .fn()
        .mockResolvedValue({ lawRoomId: null, userRoomId: null }),
    } as unknown as PalaceNavigationService;

    return new RetrievalService(
      prisma,
      embedding,
      palace,
      fakeCache(),
      fakeRerankingProvider(),
    );
  }

  it("skips the docvault query entirely when no userId is provided (fail-closed)", async () => {
    const queryRawMock = jest.fn().mockResolvedValue([]);
    const service = buildService(queryRawMock);

    const result = await service.searchUnified("Was ist Bürgergeld?", undefined);

    expect(result).toEqual([]);
    // Only the law-side query should have executed; searchAllDocvault
    // short-circuits to [] without touching the DB when userId is absent.
    expect(queryRawMock).toHaveBeenCalledTimes(1);
  });

  it("scopes the docvault query to ownerUserId when userId is provided", async () => {
    const queryRawMock = jest.fn().mockResolvedValue([]);
    const service = buildService(queryRawMock);

    await service.searchUnified("Was ist Bürgergeld?", undefined, "user-42");

    expect(queryRawMock).toHaveBeenCalledTimes(2);

    const docvaultCall = queryRawMock.mock.calls.find((call) =>
      rawSqlCall(call).sql.includes('"ownerUserId"'),
    );
    expect(docvaultCall).toBeDefined();

    const { sql, values } = rawSqlCall(docvaultCall!);
    expect(sql).toContain('"ownerUserId" =');
    expect(values).toContain("user-42");
  });

  it("narrows the docvault leg to one document when docvaultId is provided", async () => {
    const queryRawMock = jest.fn().mockResolvedValue([]);
    const service = buildService(queryRawMock);

    await service.searchUnified(
      "Was ist Bürgergeld?",
      undefined,
      "user-42",
      "doc-9",
    );

    expect(queryRawMock).toHaveBeenCalledTimes(2);

    const docvaultCall = queryRawMock.mock.calls.find((call) =>
      rawSqlCall(call).sql.includes('"ownerUserId"'),
    );
    expect(docvaultCall).toBeDefined();

    const { sql, values } = rawSqlCall(docvaultCall!);
    expect(sql).toContain('"normKey"');
    expect(values).toContain("user-42");
    // LIKE prefix with the _ separator escaped — a bare-id normKey never
    // exists (chunkNormText always emits ${id}_pN_cM), so there is no OR
    // normKey = id fallback.
    expect(values).toContain("doc-9\\_%");
    expect(values).not.toContain("doc-9");
  });
});

describe("RetrievalService.searchDocvault", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildService(queryRawMock: jest.Mock) {
    const prisma = { $queryRaw: queryRawMock } as unknown as PrismaService;
    const embedding = {
      embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    } as unknown as EmbeddingService;
    const palace = {} as unknown as PalaceNavigationService;

    return new RetrievalService(
      prisma,
      embedding,
      palace,
      fakeCache(),
      fakeRerankingProvider(),
    );
  }

  it("matches chunks suffixed with _pN_cM via LIKE, not just an exact normKey match", async () => {
    const queryRawMock = jest.fn().mockResolvedValue([
      {
        id: "1",
        lawId: "docvault",
        normKey: "doc-1_p0_c0",
        heading: null,
        text: "chunk text",
        similarity: 0.9,
      },
    ]);
    const service = buildService(queryRawMock);

    const result = await service.searchDocvault(
      "What does it say?",
      "doc-1",
      5,
      "user-42",
    );

    expect(result).toHaveLength(1);
    expect(queryRawMock).toHaveBeenCalledTimes(1);

    const { sql, values } = rawSqlCall(queryRawMock.mock.calls[0]);
    expect(sql).toContain('"normKey" LIKE');
    // No OR "normKey" = fallback: chunkNormText always emits ${id}_pN_cM,
    // so a bare-id normKey never exists and the branch was unreachable.
    expect(sql).not.toContain('OR "normKey" =');
    expect(values).toContain("doc-1\\_%");
    expect(values).not.toContain("doc-1");
  });

  it("scopes the query to ownerUserId", async () => {
    const queryRawMock = jest.fn().mockResolvedValue([]);
    const service = buildService(queryRawMock);

    await service.searchDocvault("What does it say?", "doc-1", 5, "user-42");

    const { sql, values } = rawSqlCall(queryRawMock.mock.calls[0]);
    expect(sql).toContain('"ownerUserId" =');
    expect(values).toContain("user-42");
  });

  it("fail-closed: returns [] without touching the DB when no owner is provided", async () => {
    const queryRawMock = jest.fn().mockResolvedValue([]);
    const service = buildService(queryRawMock);

    const result = await service.searchDocvault("What does it say?", "doc-1");

    expect(result).toEqual([]);
    expect(queryRawMock).not.toHaveBeenCalled();
  });

  it("cross-owner isolation: the SQL always binds the requesting owner, so user A's chunks can never match user B's query", async () => {
    const queryRawMock = jest.fn().mockResolvedValue([]);
    const service = buildService(queryRawMock);

    await service.searchDocvault("What does it say?", "doc-1", 5, "user-A");
    await service.searchDocvault("What does it say?", "doc-1", 5, "user-B");

    const callA = rawSqlCall(queryRawMock.mock.calls[0]);
    const callB = rawSqlCall(queryRawMock.mock.calls[1]);
    expect(callA.values).toContain("user-A");
    expect(callA.values).not.toContain("user-B");
    expect(callB.values).toContain("user-B");
    expect(callB.values).not.toContain("user-A");
    // Both queries share the same owner-predicated SQL shape.
    expect(callA.sql).toBe(callB.sql);
  });
});

describe("RetrievalService.search (generic law search)", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildService(queryRawMock: jest.Mock) {
    const prisma = { $queryRaw: queryRawMock } as unknown as PrismaService;
    const embedding = {
      embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    } as unknown as EmbeddingService;
    const palace = {} as unknown as PalaceNavigationService;

    return new RetrievalService(
      prisma,
      embedding,
      palace,
      fakeCache(),
      fakeRerankingProvider(),
    );
  }

  it("excludes docvault chunks so the unscoped fallback can never surface personal documents", async () => {
    const queryRawMock = jest.fn().mockResolvedValue([]);
    const service = buildService(queryRawMock);

    await service.search("Was ist Bürgergeld?");

    expect(queryRawMock).toHaveBeenCalled();
    for (const call of queryRawMock.mock.calls) {
      const { sql } = rawSqlCall(call);
      expect(sql).toContain(`"lawId" != 'docvault'`);
    }
  });
});

describe("RetrievalService rerank cache", () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  function buildService(cache: CacheService, rerankMock?: jest.Mock) {
    const queryRawMock = jest.fn().mockResolvedValue([
      {
        id: "1",
        lawId: "bgb",
        normKey: "§ 573_p0_c0",
        heading: null,
        text: "chunk text",
        similarity: 0.9,
      },
    ]);
    const prisma = { $queryRaw: queryRawMock } as unknown as PrismaService;
    const embedding = {
      embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    } as unknown as EmbeddingService;
    const palace = {} as unknown as PalaceNavigationService;

    const effectiveRerankMock =
      rerankMock ?? jest.fn().mockResolvedValue([{ index: 0, score: 0.8 }]);
    const service = new RetrievalService(
      prisma,
      embedding,
      palace,
      cache,
      fakeRerankingProvider(effectiveRerankMock),
    );

    return { service, rerankMock: effectiveRerankMock };
  }

  it("calls the reranking provider and caches the result on a cache miss", async () => {
    const setJson = jest.fn().mockResolvedValue(undefined);
    const cache = {
      getJson: jest.fn().mockResolvedValue(null),
      setJson,
    } as unknown as CacheService;
    const { service, rerankMock } = buildService(cache);

    const result = await service.search("§ 573 BGB");

    expect(rerankMock).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    // The cache holds an ORDERING over the pinned candidate set, not the
    // chunks themselves — the key already fixes which candidates these are,
    // and storing whole chunk text would multiply the entry size now that the
    // whole candidate set is ranked in one pass.
    expect(setJson).toHaveBeenCalledWith(
      expect.stringMatching(/^rerank2:/),
      [{ id: "1", score: 0.8 }],
      3_600,
    );
  });

  it("skips the reranking provider entirely on a cache hit", async () => {
    const cache = {
      getJson: jest.fn().mockResolvedValue([{ id: "1", score: 0.95 }]),
      setJson: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;
    const { service, rerankMock } = buildService(cache);

    const result = await service.search("§ 573 BGB");

    expect(rerankMock).not.toHaveBeenCalled();
    // Chunk bodies come from the candidates that were just fetched; the cache
    // supplies only the order and the score.
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("1");
    expect(result[0]!.similarity).toBe(0.95);
    expect(result[0]!.text).toBe("chunk text");
  });

  it("re-ranks instead of answering from an ordering that no longer matches the candidates", async () => {
    // The cache key pins the candidate ids, so this is only reachable if an
    // entry outlives the rows it described. Returning the partial list would
    // silently drop chunks from the answer.
    const cache = {
      getJson: jest.fn().mockResolvedValue([
        { id: "1", score: 0.95 },
        { id: "gone", score: 0.9 },
      ]),
      setJson: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;
    const { service, rerankMock } = buildService(cache);

    const result = await service.search("§ 573 BGB");

    expect(rerankMock).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
  });

  it("degrades to vector order when the reranker is down, without a lingering timer", async () => {
    jest.useFakeTimers();
    const setJson = jest.fn().mockResolvedValue(undefined);
    const cache = {
      getJson: jest.fn().mockResolvedValue(null),
      setJson,
    } as unknown as CacheService;
    const rerankMock = jest.fn().mockRejectedValue(new Error("reranker down"));
    const { service } = buildService(cache, rerankMock);

    // Previously this rejected, and the rejection travelled all the way out of
    // the answer — the user got an error instead of a slightly worse answer,
    // even though the candidates were already retrieved and ordered by cosine
    // distance. Now it degrades.
    const pending = service.search("§ 573 BGB");
    await jest.advanceTimersByTimeAsync(3_000);
    const result = await pending;

    expect(rerankMock).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("1");
    // The degraded order must NOT be cached, or it would outlive the outage
    // for the whole TTL.
    expect(setJson).not.toHaveBeenCalled();
  });

  it("shares one provider call between concurrent identical rerank requests (single-flight)", async () => {
    const cache = {
      getJson: jest.fn().mockResolvedValue(null),
      setJson: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;
    // Deferred provider: both searches must attach to the same in-flight call.
    let resolveRerank!: (
      value: Array<{ index: number; score: number }>,
    ) => void;
    const rerankMock = jest.fn(
      () =>
        new Promise<Array<{ index: number; score: number }>>((resolve) => {
          resolveRerank = resolve;
        }),
    );
    const { service } = buildService(cache, rerankMock);

    const first = service.search("§ 573 BGB");
    const second = service.search("§ 573 BGB");
    // Let both searches run through embed/query/cache-miss up to the
    // provider call before releasing it.
    await new Promise((resolve) => setImmediate(resolve));
    resolveRerank([{ index: 0, score: 0.8 }]);
    const [r1, r2] = await Promise.all([first, second]);

    expect(rerankMock).toHaveBeenCalledTimes(1);
    expect(r1).toHaveLength(1);
    expect(r2).toHaveLength(1);
  });
});

describe("RetrievalService BGE embedding storage", () => {
  it("always queries embeddingBge", async () => {
    const queryRawMock = jest.fn().mockResolvedValue([]);
    const prisma = { $queryRaw: queryRawMock } as unknown as PrismaService;
    const embedding = {
      embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    } as unknown as EmbeddingService;
    const service = new RetrievalService(
      prisma,
      embedding,
      {} as PalaceNavigationService,
      fakeCache(),
      fakeRerankingProvider(),
    );

    await service.debugSearch("query", 5);

    const sql = queryRawMock.mock.calls[0][0] as Prisma.Sql;
    expect(sql.sql).toContain('"embeddingBge"');
    expect(sql.sql).toContain('"embeddingBge" IS NOT NULL');
  });
});

describe("RetrievalService parent-norm expansion (search())", () => {
  const PREFIX = "Bürgerliches Gesetzbuch\n§ 573 Kündigung\n\n";

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function buildService(siblingRows: Array<{ normKey: string; text: string }>) {
    const topRankedRow = {
      id: "1",
      lawId: "bgb",
      normKey: "§ 573_p0_c0",
      heading: null,
      text: siblingRows[0]!.text,
      similarity: 0.9,
    };
    const queryRawMock = jest.fn().mockImplementation((...args: unknown[]) => {
      const { sql } = rawSqlCall(args);
      // Distinguishes the parent-norm sibling lookup (VALUES-joined
      // AS g(lawId, base)) from the vector-search fetchLawRows call
      // (SELECT ... similarity).
      if (sql.includes('AS g("lawId", "base")')) {
        return Promise.resolve(
          siblingRows.map((s) => ({ ...s, lawId: "bgb", base: "§ 573" })),
        );
      }
      return Promise.resolve([topRankedRow]);
    });
    const prisma = { $queryRaw: queryRawMock } as unknown as PrismaService;
    const embedding = {
      embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    } as unknown as EmbeddingService;
    const palace = {} as unknown as PalaceNavigationService;
    const cache = {
      getJson: jest.fn().mockResolvedValue(null),
      setJson: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;

    const service = new RetrievalService(
      prisma,
      embedding,
      palace,
      cache,
      fakeRerankingProvider(),
    );
    return { service, queryRawMock };
  }

  it("merges sibling paragraphs of the same § into one enriched text, deduping the shared prefix", async () => {
    const siblingRows = [
      { normKey: "§ 573_p0_c0", text: `${PREFIX}Der Vermieter kann kündigen.` },
      { normKey: "§ 573_p1_c0", text: `${PREFIX}Ausnahmen gelten für Familie.` },
    ];
    const { service } = buildService(siblingRows);

    const [result] = await service.search("§ 573 BGB");

    expect(result!.text).toBe(
      `${PREFIX}Der Vermieter kann kündigen.\n\nAusnahmen gelten für Familie.`,
    );
    // Ranking metadata is untouched — only .text was enriched.
    expect(result!.normKey).toBe("§ 573_p0_c0");
    expect(result!.similarity).toBe(0.8);
  });

  it("orders siblings by paragraph/chunk index, not DB row order", async () => {
    const siblingRows = [
      { normKey: "§ 573_p2_c0", text: `${PREFIX}Drittens.` },
      { normKey: "§ 573_p0_c0", text: `${PREFIX}Erstens.` },
      { normKey: "§ 573_p1_c0", text: `${PREFIX}Zweitens.` },
    ];
    const { service } = buildService(siblingRows);

    const [result] = await service.search("§ 573 BGB");

    expect(result!.text).toBe(`${PREFIX}Erstens.\n\nZweitens.\n\nDrittens.`);
  });

  it("leaves .text unchanged when the § has only one chunk (no siblings to merge)", async () => {
    const siblingRows = [
      { normKey: "§ 573_p0_c0", text: `${PREFIX}Only paragraph.` },
    ];
    const { service } = buildService(siblingRows);

    const [result] = await service.search("§ 573 BGB");

    expect(result!.text).toBe(`${PREFIX}Only paragraph.`);
  });

  it("does not expand docvault chunks", async () => {
    const docRow = {
      id: "1",
      lawId: "docvault",
      normKey: "doc-1_p0_c0",
      heading: null,
      text: "personal document text",
      similarity: 0.9,
    };
    const queryRawMock = jest.fn().mockResolvedValue([docRow]);
    const prisma = { $queryRaw: queryRawMock } as unknown as PrismaService;
    const embedding = {
      embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    } as unknown as EmbeddingService;
    const palace = {} as unknown as PalaceNavigationService;
    const cache = {
      getJson: jest.fn().mockResolvedValue(null),
      setJson: jest.fn().mockResolvedValue(undefined),
    } as unknown as CacheService;
    const service = new RetrievalService(
      prisma,
      embedding,
      palace,
      cache,
      fakeRerankingProvider(),
    );

    await service.search("some query");

    // Only the fetchLawRows call — no second $queryRaw for sibling lookup,
    // since docvault chunks are excluded from parent-norm grouping.
    expect(queryRawMock).toHaveBeenCalledTimes(1);
  });
});

describe("extractParagraph", () => {
  it('extracts "§ 573" with a space', () => {
    expect(extractParagraph("Wann greift § 573 BGB?")).toBe("573");
  });

  it('extracts "§573a" without a space, keeping the letter suffix', () => {
    expect(extractParagraph("Was regelt §573a BGB?")).toBe("573a");
  });

  it("lowercases an uppercase letter suffix", () => {
    expect(extractParagraph("§ 573A BGB")).toBe("573a");
  });

  it('extracts the Cyrillic form "параграф 24"', () => {
    expect(extractParagraph("что говорит параграф 24?")).toBe("24");
  });

  it('extracts only the first paragraph of a "§§ 573-575" range (current behavior)', () => {
    expect(extractParagraph("§§ 573-575 BGB")).toBe("573");
  });

  it("returns null when the query has no § citation", () => {
    expect(extractParagraph("Wann kann der Vermieter kündigen?")).toBeNull();
  });
});

describe("paragraphFilter", () => {
  it("returns Prisma.empty for null", () => {
    expect(paragraphFilter(null)).toBe(Prisma.empty);
  });

  it("matches the normKey exactly or via LIKE with chunk suffix", () => {
    const filter = paragraphFilter("573");

    const sql = filter.strings.join("");
    expect(sql).toContain('"normKey" =');
    expect(sql).toContain('"normKey" LIKE');
    expect(filter.values).toContain("§ 573");
  });

  it("escapes the LIKE underscore wildcard so § 5731 does not match", () => {
    const filter = paragraphFilter("573");

    // "\\_" is a literal backslash-underscore: LIKE treats "_" as a
    // one-character wildcard, so an unescaped "§ 573_%" would also match
    // "§ 5731_p0_c0".
    expect(filter.values).toContain("§ 573\\_%");
  });
});

describe("isExplicitLawQuery", () => {
  it("returns true for a § citation with a known law abbreviation", () => {
    expect(isExplicitLawQuery("Wann greift § 573 BGB?")).toBe(true);
  });

  it("returns true for § 24 with an explicit AufenthG mention", () => {
    expect(isExplicitLawQuery("Was regelt § 24 AufenthG?")).toBe(true);
  });

  it('returns true for a bare "§ 24" (implies AufenthG, Task 12b)', () => {
    expect(isExplicitLawQuery("Что даёт § 24?")).toBe(true);
  });

  it('returns true for a bare "параграф 24"', () => {
    expect(isExplicitLawQuery("что говорит параграф 24?")).toBe(true);
  });

  it("returns false for other bare § numbers without a law name", () => {
    expect(isExplicitLawQuery("Was sagt § 573?")).toBe(false);
    expect(isExplicitLawQuery("Was sagt § 25?")).toBe(false);
  });

  it("returns false for a law abbreviation without a § number", () => {
    expect(isExplicitLawQuery("Kündigung nach BGB")).toBe(false);
  });

  it("returns false for a plain question without any citation", () => {
    expect(isExplicitLawQuery("Wann kann der Vermieter kündigen?")).toBe(
      false,
    );
  });
});

describe("extractLawId category defaults (Task 15)", () => {
  it("visa category defaults to both AufenthG and AsylbLG when no abbreviation is present", () => {
    const { lawIds } = extractLawId("Wie lange dauert mein Verfahren?", "visa");
    expect(lawIds).toEqual(["aufenthg_2004", "asylblg"]);
  });

  it("mietvertrag category still defaults to a single law (bgb)", () => {
    const { lawIds } = extractLawId("Wann kann der Vermieter kündigen?", "mietvertrag");
    expect(lawIds).toEqual(["bgb"]);
  });

  it("an explicit AsylbLG mention narrows a visa-category query to just AsylbLG", () => {
    const { lawIds } = extractLawId("Was regelt das AsylbLG?", "visa");
    expect(lawIds).toEqual(["asylblg"]);
  });

  it("an explicit AufenthG mention narrows a visa-category query to just AufenthG", () => {
    const { lawIds } = extractLawId("Was regelt das AufenthG?", "visa");
    expect(lawIds).toEqual(["aufenthg_2004"]);
  });

  it("returns no filter when no abbreviation matches and no category is given", () => {
    const { lawIds } = extractLawId("Wie hoch ist die Miete maximal?", undefined);
    expect(lawIds).toEqual([]);
  });
});

describe("composeUnifiedChunks", () => {
  function chunk(id: string, lawId: string): ChunkSearchResult {
    return {
      id,
      lawId,
      normKey: `${id}_p0_c0`,
      heading: null,
      text: id,
      similarity: 0,
    };
  }

  it("returns the whole list untouched when it already fits the budget", () => {
    const ranked = [chunk("a", "bgb"), chunk("b", "docvault")];
    expect(composeUnifiedChunks(ranked, 10, 4)).toEqual(ranked);
  });

  it("reserves the document floor when law chunks outrank every document", () => {
    // 12 law chunks ranked above 5 document chunks: without a floor the top
    // ten are all statute text and the user's own paperwork never reaches the
    // model — the exact failure this floor exists to prevent.
    const ranked = [
      ...Array.from({ length: 12 }, (_, i) => chunk(`law-${i}`, "bgb")),
      ...Array.from({ length: 5 }, (_, i) => chunk(`doc-${i}`, "docvault")),
    ];

    const composed = composeUnifiedChunks(ranked, 10, 4);

    expect(composed).toHaveLength(10);
    expect(composed.filter((c) => c.lawId === "docvault")).toHaveLength(4);
    // The floor takes the four best documents, not an arbitrary four.
    expect(composed.filter((c) => c.lawId === "docvault").map((c) => c.id)).toEqual([
      "doc-0",
      "doc-1",
      "doc-2",
      "doc-3",
    ]);
  });

  it("preserves rank order — the floor picks which chunks survive, not their order", () => {
    const ranked = [
      chunk("law-0", "bgb"),
      chunk("doc-0", "docvault"),
      chunk("law-1", "bgb"),
      chunk("doc-1", "docvault"),
      chunk("law-2", "bgb"),
    ];

    // floor 2 reserves the two best documents (doc-0, doc-1); the single
    // remaining slot goes to the best chunk overall (law-0). Delivered in
    // rank order, not in the order the floor picked them.
    const composed = composeUnifiedChunks(ranked, 3, 2);

    expect(composed.map((c) => c.id)).toEqual(["law-0", "doc-0", "doc-1"]);

    // The invariant behind that expectation, asserted directly: output
    // positions are strictly increasing in the input ranking.
    const positions = composed.map((c) =>
      ranked.findIndex((r) => r.id === c.id),
    );
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(new Set(positions).size).toBe(positions.length);
  });

  it("is a floor, not a quota: fewer documents than the floor still fills with law", () => {
    const ranked = [
      ...Array.from({ length: 12 }, (_, i) => chunk(`law-${i}`, "bgb")),
      chunk("doc-0", "docvault"),
    ];

    const composed = composeUnifiedChunks(ranked, 10, 4);

    expect(composed).toHaveLength(10);
    expect(composed.filter((c) => c.lawId === "docvault")).toHaveLength(1);
  });

  it("clamps a floor wider than the budget instead of starving the law leg", () => {
    const ranked = [
      ...Array.from({ length: 5 }, (_, i) => chunk(`law-${i}`, "bgb")),
      ...Array.from({ length: 5 }, (_, i) => chunk(`doc-${i}`, "docvault")),
    ];

    const composed = composeUnifiedChunks(ranked, 2, 99);

    expect(composed).toHaveLength(2);
    expect(composed.every((c) => c.lawId === "docvault")).toBe(true);
  });

  it("returns nothing for a non-positive budget", () => {
    expect(composeUnifiedChunks([chunk("a", "bgb")], 0, 4)).toEqual([]);
  });
});

describe("RetrievalService unified candidate budget", () => {
  it("keeps the candidate set inside the reranker's per-request cap", () => {
    // services/retrieval-models/app/main.py rejects >48 documents (and topK
    // >48) with a 422, and searchUnified now asks the reranker to rank the
    // WHOLE candidate set — so raising either candidate constant past the cap
    // would turn every unified search into a hard failure.
    expect(UNIFIED_LAW_CANDIDATES + UNIFIED_DOC_CANDIDATES).toBeLessThanOrEqual(
      RERANK_MAX_DOCUMENTS,
    );
  });
});

describe("RetrievalService docvault room fallback (searchUnified)", () => {
  function docRow(id: string) {
    return {
      id,
      lawId: "docvault",
      normKey: `${id}_p0_c0`,
      heading: null,
      text: id,
      similarity: 0.6,
    };
  }
  function lawRow(id: string) {
    return {
      id,
      lawId: "bgb",
      normKey: `§ ${id}_p0_c0`,
      heading: null,
      text: id,
      similarity: 0.6,
    };
  }

  /** Ranks candidates in the order the DB returned them (identity ranking). */
  function identityRerank(): jest.Mock {
    return jest.fn((_q: string, documents: string[]) =>
      Promise.resolve(
        documents.map((_d, index) => ({ index, score: 1 - index / 100 })),
      ),
    );
  }

  function buildService(queryRawMock: jest.Mock, rerank: jest.Mock) {
    const prisma = { $queryRaw: queryRawMock } as unknown as PrismaService;
    const embedding = {
      embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]),
    } as unknown as EmbeddingService;
    const palace = {
      resolveRooms: jest
        .fn()
        .mockResolvedValue({ lawRoomId: "mietrecht", userRoomId: "bank" }),
    } as unknown as PalaceNavigationService;

    return new RetrievalService(
      prisma,
      embedding,
      palace,
      fakeCache(),
      fakeRerankingProvider(rerank),
    );
  }

  it("retries the docvault leg across all rooms when the room filter returns nothing", async () => {
    // The category (and therefore the room) comes from a keyword match on the
    // raw question, so one stray word can point at the wrong room and hide
    // every document the user owns. The retry is what makes that recoverable.
    const queryRawMock = jest.fn((query: Prisma.Sql) => {
      const { sql } = rawSqlCall([query]);
      if (!sql.includes('"ownerUserId"')) return Promise.resolve([lawRow("1")]);
      // First docvault attempt is room-filtered and finds nothing.
      if (sql.includes('"roomId"')) return Promise.resolve([]);
      return Promise.resolve([docRow("d1")]);
    });
    const service = buildService(queryRawMock, identityRerank());

    const result = await service.searchUnified(
      "Frist im Bescheid?",
      "bank",
      "user-42",
    );

    const docvaultCalls = queryRawMock.mock.calls.filter((call) =>
      rawSqlCall(call).sql.includes('"ownerUserId"'),
    );
    expect(docvaultCalls).toHaveLength(2);

    // The retry drops ONLY the room filter — owner scoping is never relaxed.
    const retry = rawSqlCall(docvaultCalls[1]!);
    expect(retry.sql).not.toContain('"roomId"');
    expect(retry.sql).toContain('"ownerUserId" =');
    expect(retry.values).toContain("user-42");

    expect(result.some((c) => c.lawId === "docvault")).toBe(true);
  });

  it("does not retry when the room-filtered query already found documents", async () => {
    const queryRawMock = jest.fn((query: Prisma.Sql) => {
      const { sql } = rawSqlCall([query]);
      if (!sql.includes('"ownerUserId"')) return Promise.resolve([lawRow("1")]);
      return Promise.resolve([docRow("d1")]);
    });
    const service = buildService(queryRawMock, identityRerank());

    await service.searchUnified("Frist im Bescheid?", "bank", "user-42");

    const docvaultCalls = queryRawMock.mock.calls.filter((call) =>
      rawSqlCall(call).sql.includes('"ownerUserId"'),
    );
    expect(docvaultCalls).toHaveLength(1);
  });

  it("does not retry when there is no user to scope the retry to", async () => {
    const queryRawMock = jest.fn().mockResolvedValue([]);
    const service = buildService(queryRawMock, identityRerank());

    await service.searchUnified("Frist im Bescheid?", "bank", undefined);

    // Law leg only: searchAllDocvault fails closed without a userId, and the
    // retry must not manufacture an unscoped query to "recover" from that.
    expect(queryRawMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the user's own documents in the answer when law chunks outrank them", async () => {
    const queryRawMock = jest.fn((query: Prisma.Sql) => {
      const { sql } = rawSqlCall([query]);
      if (!sql.includes('"ownerUserId"')) {
        return Promise.resolve(
          Array.from({ length: 20 }, (_, i) => lawRow(String(i))),
        );
      }
      return Promise.resolve(
        Array.from({ length: 6 }, (_, i) => docRow(`d${i}`)),
      );
    });
    // Identity ranking over [20 law, 6 doc] puts every law chunk first — the
    // pre-floor behaviour would return ten law chunks and one document.
    const service = buildService(queryRawMock, identityRerank());

    const result = await service.searchUnified(
      "Was steht in meinem Vertrag?",
      "bank",
      "user-42",
    );

    expect(result).toHaveLength(10);
    expect(result.filter((c) => c.lawId === "docvault")).toHaveLength(4);
  });
});
