import {
  CitationVerifierService,
  buildRetrievedKeys,
  extractCitations,
  normalizeLawToken,
  verifyCitations,
} from "./citation-verifier";
import { ChunkSearchResult } from "./rag.types";

function chunk(
  lawId: string,
  normKey: string,
  overrides: Partial<ChunkSearchResult> = {},
): ChunkSearchResult {
  return {
    id: `${lawId}:${normKey}`,
    lawId,
    normKey,
    heading: null,
    text: "chunk text",
    similarity: 0.9,
    ...overrides,
  };
}

describe("normalizeLawToken", () => {
  it("maps common abbreviations via LAW_ABBREVIATIONS", () => {
    expect(normalizeLawToken("BGB")).toBe("bgb");
    expect(normalizeLawToken("AufenthG")).toBe("aufenthg_2004");
    expect(normalizeLawToken("SGB II")).toBe("sgb_2");
    expect(normalizeLawToken("SGB XII")).toBe("sgb_12");
    expect(normalizeLawToken("KSchG")).toBe("kschg");
  });

  it("returns null for laws not in the map (e.g. GG)", () => {
    expect(normalizeLawToken("GG")).toBeNull();
    expect(normalizeLawToken("Mietrecht")).toBeNull();
  });
});

describe("extractCitations", () => {
  it("extracts a simple § citation", () => {
    const [c] = extractCitations("Nach § 573 BGB kann der Vermieter kündigen.");
    expect(c).toMatchObject({
      kind: "§",
      paragraphs: ["573"],
      lawToken: "BGB",
      lawId: "bgb",
    });
  });

  it("extracts letter-suffixed paragraphs (§ 573a BGB)", () => {
    const [c] = extractCitations("Siehe § 573a BGB.");
    expect(c?.paragraphs).toEqual(["573a"]);
  });

  it("extracts §§-lists with commas and 'und'", () => {
    const [c] = extractCitations("Es gelten §§ 535, 536 und 543 BGB.");
    expect(c?.paragraphs).toEqual(["535", "536", "543"]);
    expect(c?.lawId).toBe("bgb");
  });

  it("ignores Abs./Absatz/Satz/Nr. between number and law name", () => {
    const [c] = extractCitations("Gemäß § 22 Abs. 1 Satz 1 SGB II gilt...");
    expect(c).toMatchObject({
      paragraphs: ["22"],
      lawToken: "SGB II",
      lawId: "sgb_2",
    });
  });

  it("distinguishes SGB II from SGB XII", () => {
    const [c] = extractCitations("Nach § 35 SGB XII werden Kosten übernommen.");
    expect(c?.lawId).toBe("sgb_12");
  });

  it("extracts Art. citations (GG) with unknown lawId", () => {
    const [c] = extractCitations("Art. 6 Abs. 1 GG schützt die Familie.");
    expect(c).toMatchObject({
      kind: "Art.",
      paragraphs: ["6"],
      lawToken: "GG",
      lawId: null,
    });
  });

  it("returns an empty list for text without citations", () => {
    expect(extractCitations("Sie haben Anspruch auf Wohngeld.")).toEqual([]);
  });
});

describe("buildRetrievedKeys", () => {
  it("builds lawId:number keys, stripping _pN_cM chunk-split suffixes", () => {
    const keys = buildRetrievedKeys([
      chunk("bgb", "§ 573_p2_c1"),
      chunk("sgb_2", "§ 22"),
    ]);
    expect([...keys].sort()).toEqual(["bgb:573", "sgb_2:22"]);
  });

  it("keeps letter suffixes and lowercases them", () => {
    const keys = buildRetrievedKeys([chunk("bgb", "§ 573a_p1_c2")]);
    expect(keys.has("bgb:573a")).toBe(true);
  });

  it("excludes docvault (personal document) chunks", () => {
    const keys = buildRetrievedKeys([chunk("docvault", "doc-123_p1")]);
    expect(keys.size).toBe(0);
  });
});

describe("verifyCitations", () => {
  const retrieved = [chunk("bgb", "§ 573_p1_c1"), chunk("sgb_2", "§ 22_p2_c1")];

  it("matches citations that are backed by retrieved chunks", () => {
    const result = verifyCitations(
      "Nach § 573 BGB und § 22 SGB II ...",
      retrieved,
    );
    expect(result.matched.map((c) => c.citation)).toEqual([
      "§ 573 BGB",
      "§ 22 SGB II",
    ]);
    expect(result.unmatched).toEqual([]);
    expect(result.total).toBe(2);
  });

  it("flags hallucinated citations (known law, § not retrieved)", () => {
    const result = verifyCitations("Gemäß § 999 BGB ...", retrieved);
    expect(result.unmatched).toEqual([
      { citation: "§ 999 BGB", lawId: "bgb", paragraph: "999" },
    ]);
    expect(result.matched).toEqual([]);
  });

  it("checks every § of a §§-list individually", () => {
    const result = verifyCitations("Siehe §§ 573, 574 BGB.", retrieved);
    expect(result.matched.map((c) => c.paragraph)).toEqual(["573"]);
    expect(result.unmatched.map((c) => c.paragraph)).toEqual(["574"]);
  });

  it("routes Art. citations of unknown laws to unknownLaw, not unmatched", () => {
    const result = verifyCitations("Art. 6 GG schützt die Familie.", retrieved);
    expect(result.unknownLaw).toEqual([
      { citation: "Art. 6 GG", lawId: null, paragraph: "6" },
    ]);
    expect(result.unmatched).toEqual([]);
  });

  it("reports zero totals for answers without citations", () => {
    const result = verifyCitations("Kein Zitat hier.", retrieved);
    expect(result.total).toBe(0);
    expect(result.retrievedKeys.sort()).toEqual(["bgb:573", "sgb_2:22"]);
  });
});

describe("CitationVerifierService.verifyAndLog", () => {
  const retrieved = [chunk("bgb", "§ 573_p1_c1")];

  it("warns once with userId, unmatched citations and retrieved set", () => {
    const service = new CitationVerifierService();
    const warnSpy = jest
      .spyOn(
        (service as unknown as { logger: { warn: (msg: string) => void } })
          .logger,
        "warn",
      )
      .mockImplementation(() => undefined);

    const result = service.verifyAndLog(
      "Nach § 999 BGB gilt...",
      retrieved,
      "user-1",
    );

    expect(result?.unmatched).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls[0]?.[0] ?? "";
    expect(logged).toContain('"userId":"user-1"');
    expect(logged).toContain("§ 999 BGB");
    expect(logged).toContain("bgb:573");
  });

  it("does not warn when all citations are verified", () => {
    const service = new CitationVerifierService();
    const warnSpy = jest
      .spyOn(
        (service as unknown as { logger: { warn: (msg: string) => void } })
          .logger,
        "warn",
      )
      .mockImplementation(() => undefined);

    service.verifyAndLog("Nach § 573 BGB gilt...", retrieved, "user-1");

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("never throws even on internal failure", () => {
    const service = new CitationVerifierService();
    jest
      .spyOn(
        (service as unknown as { logger: { warn: (msg: string) => void } })
          .logger,
        "warn",
      )
      .mockImplementation(() => undefined);

    expect(() =>
      service.verifyAndLog(
        "Nach § 573 BGB gilt...",
        // Malformed chunk input must not break the answer flow.
        [null as unknown as ChunkSearchResult],
        "user-1",
      ),
    ).not.toThrow();
  });
});
