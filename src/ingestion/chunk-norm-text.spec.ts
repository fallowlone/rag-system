import { chunkNormText, CHUNK_SIZE_CHARS } from "./chunk-norm-text";

const PREFIX = "Bürgerliches Gesetzbuch\n§ 242 Treu und Glauben\n\n";

describe("chunkNormText", () => {
  it("returns empty array for empty text", () => {
    expect(chunkNormText("", "242", PREFIX)).toEqual([]);
  });

  it("returns one chunk for short single-paragraph text", () => {
    const text = "Der Schuldner ist verpflichtet.";
    const chunks = chunkNormText(text, "242", PREFIX);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.normKey).toBe("242_p0_c0");
    expect(chunks[0]!.text).toBe(PREFIX + text);
    expect(chunks[0]!.heading).toBeNull();
  });

  it("splits a long single-paragraph text with overlap", () => {
    const para = "A".repeat(1200);
    const chunks = chunkNormText(para, "§1", PREFIX);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.normKey).toBe("§1_p0_c0");
    expect(chunks[0]!.text).toBe(PREFIX + "A".repeat(1150));
    expect(chunks[1]!.normKey).toBe("§1_p0_c1");
    expect(chunks[1]!.text).toBe(PREFIX + "A".repeat(300));
  });

  it("packs consecutive short paragraphs into one chunk keyed by the first index", () => {
    const text = "Erster Absatz.\n\nZweiter Absatz.";
    const chunks = chunkNormText(text, "1", PREFIX);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.normKey).toBe("1_p0_c0");
    expect(chunks[0]!.text).toBe(
      PREFIX + "Erster Absatz.\n\nZweiter Absatz.",
    );
  });

  it("flushes and starts a new group when the next paragraph would overflow CHUNK_SIZE", () => {
    const first = "A".repeat(700);
    const second = "B".repeat(700);
    const third = "C".repeat(50);
    const text = `${first}\n\n${second}\n\n${third}`;
    const chunks = chunkNormText(text, "4", PREFIX);
    // first alone fits; first+second (1404 chars) would overflow 1150 → flush
    // after first, then second+third (753 chars) fit together.
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.normKey).toBe("4_p0_c0");
    expect(chunks[0]!.text).toBe(PREFIX + first);
    expect(chunks[1]!.normKey).toBe("4_p1_c0");
    expect(chunks[1]!.text).toBe(PREFIX + `${second}\n\n${third}`);
  });

  it("handles mixed short and long paragraphs", () => {
    const short = "Kurzer Satz.";
    const long = "B".repeat(2100);
    const text = `${short}\n\n${long}`;
    const chunks = chunkNormText(text, "10", PREFIX);
    expect(chunks).toHaveLength(4);
    expect(chunks[0]!.normKey).toBe("10_p0_c0");
    expect(chunks[1]!.normKey).toBe("10_p1_c0");
    expect(chunks[2]!.normKey).toBe("10_p1_c1");
    expect(chunks[3]!.normKey).toBe("10_p1_c2");
  });

  it("skips whitespace-only paragraphs", () => {
    const text = "Erster.\n\n   \n\nZweiter.";
    const chunks = chunkNormText(text, "2", PREFIX);
    // The blank paragraph is dropped before packing, so "Erster." and
    // "Zweiter." end up adjacent and packed into a single chunk.
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.normKey).toBe("2_p0_c0");
    expect(chunks[0]!.text).toBe(PREFIX + "Erster.\n\nZweiter.");
  });

  it("normalizes whitespace within each paragraph", () => {
    const text = "Viel   Leerzeichen   hier.";
    const chunks = chunkNormText(text, "3", PREFIX);
    expect(chunks[0]!.text).toBe(PREFIX + "Viel Leerzeichen hier.");
  });

  it("never cuts a word when sliding-window chunking a long single paragraph", () => {
    const text = Array(200).fill("Paragraph").join(" ");
    const chunks = chunkNormText(text, "500", PREFIX);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const body = chunk.text.slice(PREFIX.length).trim();
      expect(body.length).toBeGreaterThan(0);
      expect(body.endsWith("Paragraph")).toBe(true);
      for (const word of body.split(" ")) {
        expect(word).toBe("Paragraph");
      }
    }
  });
});

describe("chunk size against the embedder's window", () => {
  it("stays inside EMBED_MAX_LENGTH with margin for German legal prose", () => {
    // services/retrieval-models/app/main.py pins EMBED_MAX_LENGTH = 512 and
    // BGE-M3 truncates past it SILENTLY — an oversized chunk loses its tail
    // from the vector and nothing on either side reports it. German legal text
    // runs ~3 chars/token at worst under the XLM-R tokenizer, so the chunk
    // plus its norm prefix must fit 512 tokens at that ratio.
    const EMBED_MAX_TOKENS = 512;
    const WORST_CASE_CHARS_PER_TOKEN = 3;
    const PREFIX_BUDGET_CHARS = 200; // lawTitle + normKey + heading line

    expect(
      (CHUNK_SIZE_CHARS + PREFIX_BUDGET_CHARS) / WORST_CASE_CHARS_PER_TOKEN,
    ).toBeLessThanOrEqual(EMBED_MAX_TOKENS);
  });
});
