import { DocumentQualityService } from "./document-quality.service";
import { AppDocumentIngestInput } from "./app-api.types";

function futureIso(daysAhead: number): string {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  return date.toISOString().slice(0, 10);
}

function buildInput(
  overrides: Partial<AppDocumentIngestInput> = {},
): AppDocumentIngestInput {
  return {
    sourceHash: "a".repeat(64),
    fileName: "bescheid.pdf",
    title: "Bewilligungsbescheid Bürgergeld",
    sender: "Jobcenter Berlin",
    category: "jobcenter",
    docDate: "2026-09-01",
    summary: "Bewilligung von Bürgergeld ab Oktober.",
    facts: [{ content: "Bewilligung ab 01.10.2026", importance: "high" }],
    deadlines: [
      {
        label: "Widerspruch einlegen",
        date: futureIso(30),
        kind: "Widerspruchsfrist",
      },
    ],
    obligations: ["Nachweis einreichen"],
    addresses: [{ purpose: "Jobcenter", address: "Musterstr. 1, 10115 Berlin" }],
    amounts: [{ label: "Bürgergeld", value: "563", currency: "EUR" }],
    tags: ["Bürgergeld"],
    isActive: true,
    ...overrides,
  };
}

describe("DocumentQualityService", () => {
  const service = new DocumentQualityService();

  it("scores a complete extraction at 100 with no issues", () => {
    const report = service.assess(buildInput());
    expect(report).toEqual({ score: 100, issues: [] });
  });

  it("flags an extraction without facts as high severity", () => {
    const report = service.assess(buildInput({ facts: [] }));
    expect(report.score).toBeLessThan(100);
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "no_facts", severity: "high" }),
    );
  });

  it("flags a jobcenter payload with neither amounts nor deadlines", () => {
    const report = service.assess(
      buildInput({ amounts: [], deadlines: [], obligations: [] }),
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "category_fields_missing",
        severity: "high",
      }),
    );
  });

  it("does not apply category expectations to 'other'", () => {
    const report = service.assess(
      buildInput({ category: "other", amounts: [], deadlines: [] }),
    );
    expect(
      report.issues.some((i) => i.code === "category_fields_missing"),
    ).toBe(false);
  });

  it("flags past deadlines as unusable", () => {
    const report = service.assess(
      buildInput({
        deadlines: [{ label: "Veraltet", date: "2020-01-01" }],
        obligations: [],
      }),    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "unusable_deadlines",
        severity: "medium",
      }),
    );
  });

  it("flags duplicate facts (case/whitespace-insensitive)", () => {
    const report = service.assess(
      buildInput({
        facts: [
          { content: "Bewilligung ab 01.10.2026", importance: "high" },
          { content: "  bewilligung AB 01.10.2026 ", importance: "low" },
        ],
      }),
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "duplicate_facts", severity: "low" }),
    );
  });

  it("flags obligations without any deadline", () => {
    const report = service.assess(buildInput({ deadlines: [] }));
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        code: "obligations_without_deadlines",
        severity: "low",
      }),
    );
  });

  it("flags obligations when the only deadlines are unusable (filtered at ingest)", () => {
    const report = service.assess(
      buildInput({
        deadlines: [{ label: "Veraltet", date: "2020-01-01" }],
      }),
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "obligations_without_deadlines" }),
    );
  });

  it("flags a missing summary and missing dates", () => {
    const report = service.assess(
      buildInput({
        summary: undefined,
        docDate: undefined,
        expiryDate: undefined,
      }),
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "missing_summary" }),
    );
    expect(report.issues).toContainEqual(
      expect.objectContaining({ code: "no_dates" }),
    );
  });

  it("clamps the score at 0 for a fully broken extraction", () => {
    const report = service.assess(
      buildInput({
        summary: undefined,
        docDate: undefined,
        facts: [],
        amounts: [],
        deadlines: [{ label: "Veraltet", date: "2020-01-01" }],
      }),
    );
    expect(report.score).toBeGreaterThanOrEqual(0);
    expect(report.score).toBeLessThanOrEqual(100);
  });
});
