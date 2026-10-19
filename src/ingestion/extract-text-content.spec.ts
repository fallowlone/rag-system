import { extractTextContent } from "./law-fetcher.service";

describe("extractTextContent", () => {
  it("joins P array siblings with a blank line (Absatz boundaries)", () => {
    expect(extractTextContent(["(1) Erster", "(2) Zweiter"], "P")).toBe(
      "(1) Erster\n\n(2) Zweiter",
    );
  });

  it("space-joins non-P array siblings", () => {
    expect(extractTextContent(["a", "b"], "SomeInline")).toBe("a b");
  });

  it("excludes a table key from extraction", () => {
    expect(extractTextContent({ P: ["Text"], table: { row: "junk" } })).toBe(
      "Text",
    );
  });

  it("returns empty string for null", () => {
    expect(extractTextContent(null)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(extractTextContent(undefined)).toBe("");
  });

  it("returns empty string for boolean values", () => {
    expect(extractTextContent(true)).toBe("");
    expect(extractTextContent(false)).toBe("");
  });

  it("stringifies numbers", () => {
    expect(extractTextContent(42)).toBe("42");
  });

  it("returns strings unchanged", () => {
    expect(extractTextContent("x")).toBe("x");
  });

  it("does not stack-overflow on pathologically deep nesting and truncates past the depth cap", () => {
    // Build { a: { a: { a: ... "leaf" } } } 500 levels deep — far past any
    // real GII norm structure, simulating a hostile/malformed document.
    let node: unknown = "leaf";
    for (let i = 0; i < 500; i++) {
      node = { a: node };
    }

    expect(() => extractTextContent(node)).not.toThrow();
    // "leaf" sits well past MAX_XML_NESTING_DEPTH, so it's cut off — the
    // point of the guard is bounded recursion, not lossless extraction of
    // adversarial input.
    expect(extractTextContent(node)).toBe("");
  });

  it("still extracts normally within the depth cap", () => {
    let node: unknown = "leaf";
    for (let i = 0; i < 10; i++) {
      node = { a: node };
    }

    expect(extractTextContent(node)).toBe("leaf");
  });
});
