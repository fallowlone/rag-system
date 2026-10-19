# Extraction recall harness

Regression harness for the on-device extraction pipeline
(`file → text → local model → ensure_key_details → Extraction JSON`).
It answers one question the project could not previously answer: **did a
change to the prompt, the model or the backstop make recall better or worse?**

## Why two tiers

The failure mode is *stochastic*. The recorded history is "BG-Nummer survived
**0 of 4** runs, Berater phone **1 of 4**" — an extractor that drops a
different detail each run. A harness that runs each fixture once reports
whichever side of that coin it landed on, which is exactly how a brittle
extractor can look healthy indefinitely.

| | Tier 1 | Tier 2 |
|---|---|---|
| what it scores | `ensure_key_details` on top of an **empty** extraction | the real model, end to end |
| model needed | no | yes (~4.8 GB GGUF, `llama` feature) |
| determinism | byte-reproducible | stochastic — that is the measurement |
| runs | 1 | N (default 5) |
| verdict | **hard CI gate** | recall table + baseline delta |

Tier 1 asserts only what the deterministic backstop *claims* to guarantee, so
a failure is unambiguously a regression. Tier 2 reports `found_runs / N` per
planted detail; its headline column is `FLAK` — details the model finds
sometimes.

## Running

```bash
cargo test -p dokumente-core --test extraction_recall -- --nocapture
```

```bash
cargo run -p dokumente-core --features llama --example eval-extraction -- \
    /tmp/dokumente-eval/qwen3-8b.gguf --runs 5
```

Flags: `--runs N`, `--fixture <name>`, `--write-baseline`.
Per-run JSON lands in `results/` (gitignored); `baseline.json` is committed
and every later run is diffed against it.

## Files

- `fixtures/` — synthetic German documents with deliberately planted details.
  **All people, companies, addresses, phone numbers, IBANs, e-mail addresses,
  reference numbers and amounts in them are fictional.** Any resemblance to
  real persons or organisations is coincidental. Names of public authorities
  (e.g. Jobcenter, Ausländerbehörde) and of a savings-bank group appear only
  as generic document types; the documents are invented and are not issued
  by, or attributable to, any real body. No real user data.
- `expected/<fixture>.json` — the planted details, each with a match rule and
  a tier; plus `forbidden` values that must never appear.
- `baseline.json` — committed Tier 2 numbers; the regression reference.
- Scoring lives in `apps/macos/crates/dokumente-core/src/eval.rs`.

## Fixture composition

| fixture | category | chars | why it exists |
|---|---|---|---|
| `bescheid-jobcenter.txt` | jobcenter | 1.4k | baseline; the original 11-planted-detail fixture |
| `mietvertrag.txt` | mietvertrag | 1.4k | contract terms, `Buerozeiten` (an unanchored label) |
| `bank-dispo.txt` | bank | 0.9k | carries an IBAN twice — the masking invariant |
| `visa-fiktionsbescheinigung.txt` | visa | 1.0k | carries a Geburtsdatum — the privacy filter |
| `versicherung-kfz.txt` | versicherung | 1.5k | the category with no fixture before; Versicherungsnummer + e-mail are unanchored |
| `long-bescheid.txt` | jobcenter | **26.5k** | exceeds `MAX_PROMPT_DOC_CHARS` (24,000) |

### The long fixture is the important one

Details in `long-bescheid.txt` are marked `beyondCut: true` when they sit past
the 24,000-char prompt limit. The two halves of the pipeline behave
differently there, and the fixture is built to expose the split:

- `ensure_key_details` scans the **full** text, so deterministic details in
  the tail (phone, Zimmer, Sprechzeiten) **must** still be recovered — Tier 1
  asserts this.
- The model only ever sees the first 24,000 chars, so the model-tier tail
  details (Widerspruchsfrist `2027-01-15`, a `1.842,50 Euro` back-payment, two
  further deadlines) are expected to be **lost** in a single pass.

Tier 2's `model recall beyond the 24k cut` line is therefore the direct
measurement of what multi-pass extraction (plan item **A2**) would recover,
and the number that decides whether A2 is worth N× local inference.

## Match rules

| kind | matches |
|---|---|
| `text` | normalized substring — lowercased, whitespace collapsed, dash variants unified (`9:00–12:00` ≡ `9:00-12:00`) |
| `digits` | digits-only substring, so `030 555 789 12` ≡ `03055578912` |
| `iso_date` | the structured date fields, or the text in ISO or `DD.MM.YYYY` form |

Matching runs against the **union** of all extraction fields, never
per-field: the model legitimately moves content between `summary`, `facts`
and `amounts` between runs, so per-field scoring would manufacture false
misses.

## Tiers are a claim about the code, not about difficulty

A detail is `deterministic` only when `ensure_key_details` anchors on its
label today. `Versicherungsnummer` and the e-mail address in
`versicherung-kfz.txt` are `model` tier purely because those labels are not in
the list yet — they are the A4 candidates. **When A4 adds a label, move the
detail to `deterministic` in the same commit**; that promotion is what proves
the change did something.

## Known limitation: the fixtures contain absolute dates

Deadlines like `2026-09-30` will drift into the past as real time passes. The
scorer itself is time-independent (it reads extraction output, not the quality
gate), but a model may reasonably decline to report a long-past deadline. If
Tier 2 recall degrades across the board with no code change, check the dates
before suspecting the model.
