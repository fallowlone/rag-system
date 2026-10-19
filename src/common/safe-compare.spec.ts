import { safeCompare } from "./safe-compare";

describe("safeCompare", () => {
  it("returns true for equal strings", () => {
    expect(safeCompare("secret-token-123", "secret-token-123")).toBe(true);
  });

  it("returns false for strings that differ", () => {
    expect(safeCompare("secret-token-123", "secret-token-124")).toBe(false);
  });

  it("returns false for strings of different length", () => {
    expect(safeCompare("short", "a-much-longer-string")).toBe(false);
  });

  it("does not throw on length mismatch", () => {
    expect(() => safeCompare("a", "abcdefgh")).not.toThrow();
  });

  it("returns true for two empty strings", () => {
    expect(safeCompare("", "")).toBe(true);
  });

  it("returns false when one side is empty", () => {
    expect(safeCompare("", "nonempty")).toBe(false);
  });
});
