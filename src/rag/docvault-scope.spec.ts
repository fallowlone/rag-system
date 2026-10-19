import {
  docvaultIdFromNormKey,
  docvaultNormKeyFilter,
} from "./docvault-scope";

describe("docvaultNormKeyFilter", () => {
  it("matches every chunk of the document via a LIKE prefix", () => {
    const filter = docvaultNormKeyFilter("doc-9");
    expect(filter.sql).toContain('"normKey" LIKE');
    expect(filter.values).toContain("doc-9\\_%");
  });

  it("escapes _ in the id so a prefix id never matches a longer sibling id", () => {
    // Without escaping, doc_9\_% would still match, but an id like "doc"
    // with pattern "doc\_%" must not match "docx_p0_c0" — the literal _
    // in "doc_9" must not act as a single-char wildcard.
    const filter = docvaultNormKeyFilter("doc_9");
    expect(filter.values).toContain("doc\\_9\\_%");
  });

  it("escapes % in the id", () => {
    const filter = docvaultNormKeyFilter("doc%9");
    expect(filter.values).toContain("doc\\%9\\_%");
  });

  it("has no bare-id OR fallback — chunkNormText always emits ${id}_pN_cM", () => {
    const filter = docvaultNormKeyFilter("doc-9");
    expect(filter.sql).not.toContain("OR");
  });
});

describe("docvaultIdFromNormKey", () => {
  it("recovers the document id from a chunk normKey", () => {
    expect(docvaultIdFromNormKey("doc-9_p0_c0")).toBe("doc-9");
    expect(docvaultIdFromNormKey("doc-9_p12_c3")).toBe("doc-9");
  });

  it("round-trips ids that contain the separator themselves", () => {
    expect(docvaultIdFromNormKey("a_b_c_p1_c2")).toBe("a_b_c");
  });

  it("returns null rather than guessing on a key without the chunk suffix", () => {
    // A law normKey ("§ 573") must never be read as a document id — the
    // caller would then look up a document that is not the user's.
    expect(docvaultIdFromNormKey("§ 573")).toBeNull();
    expect(docvaultIdFromNormKey("doc-9")).toBeNull();
    expect(docvaultIdFromNormKey("doc-9_p0")).toBeNull();
  });

  it("returns null when nothing precedes the suffix", () => {
    expect(docvaultIdFromNormKey("_p0_c0")).toBeNull();
  });

  it("is the inverse of the filter's prefix for a real chunk key", () => {
    const id = "3f2b1c8e-0000-4aaa-9bbb-ccccdddd1111";
    expect(docvaultIdFromNormKey(`${id}_p3_c1`)).toBe(id);
    expect(docvaultNormKeyFilter(id).values).toContain(`${id}\\_%`);
  });
});
