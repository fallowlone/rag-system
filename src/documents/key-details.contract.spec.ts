/**
 * Cross-language contract test.
 *
 * `extractKeyDetails` (Telegram) and `ensure_key_details` (macOS) are two
 * implementations of one promise: whatever the shared expectations in
 * `eval/extraction/expected/*.json` mark `deterministic` is recovered from
 * the raw text WITHOUT the model. The Rust side is gated by
 * `tests/extraction_recall.rs`; this gates the TypeScript side against the
 * same fixtures, with the same match rules.
 *
 * Two implementations of one guarantee drift — that is what half of the
 * findings in this repo's audits have been. This test is what makes the
 * drift a failure instead of a difference nobody notices.
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { extractKeyDetails } from "./key-details";

const EVAL_DIR = join(__dirname, "..", "..", "eval", "extraction");

interface PlantedDetail {
  id: string;
  label: string;
  kind: "text" | "digits" | "iso_date";
  value: string;
  tier: "deterministic" | "model";
}

interface FixtureExpectation {
  fixture: string;
  details: PlantedDetail[];
}

/** Port of `eval::normalize_for_match`: dash unification, case, whitespace. */
function normalizeForMatch(text: string): string {
  return text
    .replace(/[‐-―−]/gu, "-")
    .replace(/[  ]/gu, " ")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
}

function digitsOnly(text: string): string {
  return text.replace(/\D/gu, "");
}

/** `2026-09-30` → `30.09.2026`; null for anything not ISO-shaped. */
function germanDate(iso: string): string | null {
  const parts = iso.split("-");
  if (parts.length !== 3) return null;
  const [y, m, d] = parts;
  if (y.length !== 4 || m.length !== 2 || d.length !== 2) return null;
  return `${d}.${m}.${y}`;
}

function isFound(detail: PlantedDetail, facts: string[]): boolean {
  const joined = facts.join("\n");
  const text = normalizeForMatch(joined);
  switch (detail.kind) {
    case "digits":
      return digitsOnly(joined).includes(digitsOnly(detail.value));
    case "iso_date": {
      if (text.includes(normalizeForMatch(detail.value))) return true;
      const german = germanDate(detail.value);
      return german !== null && text.includes(german);
    }
    default:
      return text.includes(normalizeForMatch(detail.value));
  }
}

function loadExpectations(): FixtureExpectation[] {
  const dir = join(EVAL_DIR, "expected");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as FixtureExpectation);
}

describe("deterministic key details: TypeScript matches the Rust contract", () => {
  const expectations = loadExpectations();

  it("finds every fixture", () => {
    // A silently empty fixture list would make every assertion below vacuous.
    expect(expectations.length).toBeGreaterThanOrEqual(6);
  });

  for (const expectation of expectations) {
    const deterministic = expectation.details.filter((d) => d.tier === "deterministic");
    if (deterministic.length === 0) continue;

    it(`recovers every deterministic detail of ${expectation.fixture}`, () => {
      const raw = readFileSync(join(EVAL_DIR, "fixtures", expectation.fixture), "utf-8");
      // Worst case, exactly as the Rust Tier 1 harness runs it: the model
      // produced nothing at all.
      const facts = extractKeyDetails(raw, []);

      const missing = deterministic
        .filter((d) => !isFound(d, facts))
        .map((d) => `${d.id} (${d.label} = ${d.value})`);

      expect(missing).toEqual([]);
    });
  }

  it("never repeats a detail the model already reported", () => {
    const raw = readFileSync(join(EVAL_DIR, "fixtures", "bescheid-jobcenter.txt"), "utf-8");
    const all = extractKeyDetails(raw, []);
    expect(all.length).toBeGreaterThan(0);
    // Feeding its own output back as the model's must add nothing.
    expect(extractKeyDetails(raw, all)).toEqual([]);
  });
});
