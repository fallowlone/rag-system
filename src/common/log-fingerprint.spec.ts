import { fingerprint } from "./log-fingerprint";

describe("fingerprint", () => {
  it("never contains the input text", () => {
    const text = "Sehr geehrte Damen und Herren, mein Aktenzeichen ist 123-ABC";
    const printed = fingerprint(text);
    expect(printed).not.toContain("Aktenzeichen");
    expect(printed).not.toContain("123-ABC");
    expect(printed).toContain(`len=${text.length}`);
  });

  it("is stable and distinguishes different inputs", () => {
    expect(fingerprint("widerspruch")).toBe(fingerprint("widerspruch"));
    expect(fingerprint("widerspruch")).not.toBe(fingerprint("klage"));
  });
});
