import { embeddingColumnSql } from "./embedding-storage";

describe("embedding storage SQL", () => {
  it("always targets the BGE-M3 column", () => {
    expect(embeddingColumnSql().sql).toBe('"embeddingBge"');
  });

  it("supports an aliased BGE-M3 column", () => {
    expect(embeddingColumnSql("m").sql).toBe('m."embeddingBge"');
  });
});
