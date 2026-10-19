import { toTrustedLawUrl } from "./trusted-law-url";

describe("toTrustedLawUrl", () => {
  it("rewrites the real GII http link to https", () => {
    expect(toTrustedLawUrl("http://www.gesetze-im-internet.de/bgb/xml.zip")).toBe(
      "https://www.gesetze-im-internet.de/bgb/xml.zip",
    );
  });

  it("passes through an already-https GII link unchanged", () => {
    expect(toTrustedLawUrl("https://www.gesetze-im-internet.de/stgb/xml.zip")).toBe(
      "https://www.gesetze-im-internet.de/stgb/xml.zip",
    );
  });

  it("rejects a different host", () => {
    expect(toTrustedLawUrl("http://evil.example.com/bgb/xml.zip")).toBeNull();
  });

  it("rejects a lookalike host (subdomain confusion)", () => {
    expect(
      toTrustedLawUrl("http://www.gesetze-im-internet.de.evil.com/bgb/xml.zip"),
    ).toBeNull();
  });

  it("rejects a non-http(s) scheme even on the trusted host", () => {
    expect(toTrustedLawUrl("file://www.gesetze-im-internet.de/etc/passwd")).toBeNull();
  });

  it("rejects a malformed URL", () => {
    expect(toTrustedLawUrl("not a url")).toBeNull();
  });

  it("rejects an internal/SSRF-style target", () => {
    expect(toTrustedLawUrl("http://169.254.169.254/latest/meta-data/")).toBeNull();
  });
});
