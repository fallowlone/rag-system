//! Extraction-recall scoring for the eval harness in `eval/extraction/`.
//!
//! Not production code, but not test-only either: both the Tier 1
//! integration test (`tests/extraction_recall.rs`, deterministic, runs in
//! CI without a model) and the Tier 2 example (`examples/eval-extraction.rs`,
//! real GGUF, N runs) score against these functions, so they live in the lib
//! rather than being duplicated in each.
//!
//! # Why two tiers
//!
//! The extraction failure mode is *stochastic*, not deterministic: the
//! measured history is "BG-Nummer survived 0 of 4 runs, Berater phone 1 of
//! 4". A harness that runs each fixture once reports whichever side of that
//! coin it happened to land on. So:
//!
//! * **Tier 1** scores only what `ensure_key_details` deterministically
//!   guarantees. Byte-reproducible, no model, hard CI gate.
//! * **Tier 2** runs the real model N times and reports `found_runs / N`
//!   per detail — a brittleness measurement, not a pass/fail.

use crate::types::Extraction;
use serde::Deserialize;
use std::path::{Path, PathBuf};

/// Which half of the pipeline is responsible for a planted detail.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Tier {
    /// `ensure_key_details` claims to guarantee it — a miss is a regression.
    Deterministic,
    /// Only the LLM can produce it — a miss is a data point, not a failure.
    Model,
}

fn default_tier() -> Tier {
    Tier::Model
}

/// How a planted value is matched against the extraction output.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchKind {
    /// Normalized substring (lowercased, whitespace collapsed, dashes unified).
    Text,
    /// Digits-only substring — phone numbers survive any spacing convention
    /// ("030 55578912" vs "03055578912" vs "030/55578912").
    Digits,
    /// `YYYY-MM-DD`, matched against the structured date fields *and* against
    /// the text in both ISO and German `DD.MM.YYYY` rendering.
    IsoDate,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlantedDetail {
    pub id: String,
    pub label: String,
    pub kind: MatchKind,
    pub value: String,
    #[serde(default = "default_tier")]
    pub tier: Tier,
    /// True when the detail sits past `MAX_PROMPT_DOC_CHARS` in the fixture.
    /// The model cannot see it in a single pass; the deterministic backstop
    /// can, because it scans the full text.
    #[serde(default)]
    pub beyond_cut: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureExpectation {
    pub fixture: String,
    pub category: String,
    #[serde(default)]
    pub note: String,
    pub details: Vec<PlantedDetail>,
    /// Values that must NEVER appear — IBANs, birthdates, boilerplate. The
    /// privacy filter is a product invariant, so a leak fails Tier 1 even
    /// though the model produced it.
    #[serde(default)]
    pub forbidden: Vec<PlantedDetail>,
}

/// Repo-root `eval/extraction`, resolved from the crate manifest so the test
/// and the example agree regardless of the shell's working directory.
pub fn eval_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../../eval/extraction")
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from("eval/extraction"))
}

/// Loads every `expected/*.json`, sorted by fixture name for stable output.
pub fn load_expectations() -> std::io::Result<Vec<FixtureExpectation>> {
    let dir = eval_dir().join("expected");
    let mut out = Vec::new();
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
        .collect();
    paths.sort();
    for path in paths {
        let raw = std::fs::read_to_string(&path)?;
        let parsed: FixtureExpectation = serde_json::from_str(&raw).map_err(|err| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                format!("{}: {err}", path.display()),
            )
        })?;
        out.push(parsed);
    }
    Ok(out)
}

/// Lowercases, collapses whitespace runs to one space, and unifies the dash
/// variants German documents mix freely (en dash in "9:00–12:00", hyphen in
/// the model's paraphrase of the same range).
pub fn normalize_for_match(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last_space = false;
    for ch in text.chars() {
        let ch = match ch {
            '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
            '\u{00a0}' | '\u{202f}' => ' ',
            other => other,
        };
        if ch.is_whitespace() {
            if !last_space {
                out.push(' ');
            }
            last_space = true;
            continue;
        }
        last_space = false;
        for lower in ch.to_lowercase() {
            out.push(lower);
        }
    }
    out.trim().to_string()
}

pub fn digits_only(text: &str) -> String {
    text.chars().filter(|c| c.is_ascii_digit()).collect()
}

/// `2026-09-30` → `30.09.2026`. Returns None for anything not ISO-shaped —
/// the caller then only checks the ISO form.
fn german_date(iso: &str) -> Option<String> {
    let parts: Vec<&str> = iso.split('-').collect();
    if parts.len() != 3 || parts[0].len() != 4 || parts[1].len() != 2 || parts[2].len() != 2 {
        return None;
    }
    if !iso.chars().all(|c| c.is_ascii_digit() || c == '-') {
        return None;
    }
    Some(format!("{}.{}.{}", parts[2], parts[1], parts[0]))
}

/// Flattened extraction output. Matching runs against the UNION of every
/// field rather than per-field on purpose: the model legitimately moves
/// content between `summary`, `facts` and `amounts` from run to run (the
/// project's own notes record "facts carry the content" when summary comes
/// back empty), so per-field scoring would manufacture false misses.
pub struct Haystack {
    pub text: String,
    pub digits: String,
    pub dates: Vec<String>,
}

impl Haystack {
    pub fn from_extraction(extraction: &Extraction) -> Self {
        let mut parts: Vec<String> = Vec::new();
        let mut dates: Vec<String> = Vec::new();

        if let Some(title) = &extraction.title {
            parts.push(title.clone());
        }
        if let Some(sender) = &extraction.sender {
            parts.push(sender.clone());
        }
        if let Some(summary) = &extraction.summary {
            parts.push(summary.clone());
        }
        for fact in &extraction.facts {
            parts.push(fact.content.clone());
        }
        for obligation in &extraction.obligations {
            parts.push(obligation.clone());
        }
        for tag in &extraction.tags {
            parts.push(tag.clone());
        }
        for address in &extraction.addresses {
            if let Some(purpose) = &address.purpose {
                parts.push(purpose.clone());
            }
            parts.push(address.address.clone());
        }
        for amount in &extraction.amounts {
            if let Some(label) = &amount.label {
                parts.push(label.clone());
            }
            parts.push(amount.value.clone());
            if let Some(currency) = &amount.currency {
                parts.push(currency.clone());
            }
        }
        for deadline in &extraction.deadlines {
            parts.push(deadline.label.clone());
            if let Some(kind) = &deadline.kind {
                parts.push(kind.clone());
            }
            parts.push(deadline.date.0.clone());
            dates.push(deadline.date.0.clone());
        }
        if let Some(doc_date) = &extraction.doc_date {
            parts.push(doc_date.0.clone());
            dates.push(doc_date.0.clone());
        }
        if let Some(expiry) = &extraction.expiry_date {
            parts.push(expiry.0.clone());
            dates.push(expiry.0.clone());
        }

        let joined = parts.join("\n");
        Haystack {
            text: normalize_for_match(&joined),
            digits: digits_only(&joined),
            dates,
        }
    }
}

/// True when the planted value is present anywhere in the extraction output.
pub fn is_found(detail: &PlantedDetail, haystack: &Haystack) -> bool {
    match detail.kind {
        MatchKind::Text => {
            let needle = normalize_for_match(&detail.value);
            !needle.is_empty() && haystack.text.contains(&needle)
        }
        MatchKind::Digits => {
            let needle = digits_only(&detail.value);
            !needle.is_empty() && haystack.digits.contains(&needle)
        }
        MatchKind::IsoDate => {
            if haystack.dates.iter().any(|d| d == &detail.value) {
                return true;
            }
            let iso = normalize_for_match(&detail.value);
            if !iso.is_empty() && haystack.text.contains(&iso) {
                return true;
            }
            german_date(&detail.value)
                .map(|de| haystack.text.contains(&de))
                .unwrap_or(false)
        }
    }
}

#[derive(Debug, Clone)]
pub struct DetailOutcome {
    pub id: String,
    pub label: String,
    pub tier: Tier,
    pub beyond_cut: bool,
    pub found: bool,
}

#[derive(Debug, Clone)]
pub struct FixtureReport {
    pub fixture: String,
    pub outcomes: Vec<DetailOutcome>,
    /// Forbidden values that leaked into the output — always a failure.
    pub leaked: Vec<String>,
}

impl FixtureReport {
    /// Recall over the details of one tier, or over all details when `tier`
    /// is None. Returns 1.0 for an empty selection (nothing to miss).
    pub fn recall(&self, tier: Option<Tier>) -> f64 {
        let selected: Vec<&DetailOutcome> = self
            .outcomes
            .iter()
            .filter(|o| tier.is_none_or(|t| o.tier == t))
            .collect();
        if selected.is_empty() {
            return 1.0;
        }
        let found = selected.iter().filter(|o| o.found).count();
        found as f64 / selected.len() as f64
    }

    pub fn missing(&self, tier: Option<Tier>) -> Vec<&DetailOutcome> {
        self.outcomes
            .iter()
            .filter(|o| !o.found && tier.is_none_or(|t| o.tier == t))
            .collect()
    }
}

pub fn score_fixture(expectation: &FixtureExpectation, extraction: &Extraction) -> FixtureReport {
    let haystack = Haystack::from_extraction(extraction);

    let outcomes = expectation
        .details
        .iter()
        .map(|detail| DetailOutcome {
            id: detail.id.clone(),
            label: detail.label.clone(),
            tier: detail.tier,
            beyond_cut: detail.beyond_cut,
            found: is_found(detail, &haystack),
        })
        .collect();

    let leaked = expectation
        .forbidden
        .iter()
        .filter(|detail| is_found(detail, &haystack))
        .map(|detail| format!("{} ({})", detail.label, detail.id))
        .collect();

    FixtureReport {
        fixture: expectation.fixture.clone(),
        outcomes,
        leaked,
    }
}

/// Aggregates N runs of one fixture: how many runs found each detail.
/// This is the Tier 2 output — a single run cannot measure a stochastic drop.
#[derive(Debug, Clone)]
pub struct RecallMatrix {
    pub fixture: String,
    pub runs: usize,
    /// `(id, label, tier, beyond_cut, found_runs)`
    pub per_detail: Vec<(String, String, Tier, bool, usize)>,
    pub leaked_runs: usize,
}

impl RecallMatrix {
    pub fn from_reports(fixture: &str, reports: &[FixtureReport]) -> Self {
        let runs = reports.len();
        let mut per_detail: Vec<(String, String, Tier, bool, usize)> = Vec::new();

        if let Some(first) = reports.first() {
            for (index, outcome) in first.outcomes.iter().enumerate() {
                let found_runs = reports
                    .iter()
                    .filter(|r| r.outcomes.get(index).is_some_and(|o| o.found))
                    .count();
                per_detail.push((
                    outcome.id.clone(),
                    outcome.label.clone(),
                    outcome.tier,
                    outcome.beyond_cut,
                    found_runs,
                ));
            }
        }

        RecallMatrix {
            fixture: fixture.to_string(),
            runs,
            per_detail,
            leaked_runs: reports.iter().filter(|r| !r.leaked.is_empty()).count(),
        }
    }

    /// Details that were found in some runs but not all — the brittleness
    /// this harness exists to expose.
    pub fn flaky(&self) -> Vec<&(String, String, Tier, bool, usize)> {
        self.per_detail
            .iter()
            .filter(|(_, _, _, _, found)| *found > 0 && *found < self.runs)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Amount, Category, Deadline, Fact, Importance, IsoDate};

    fn extraction_with(facts: Vec<&str>) -> Extraction {
        Extraction {
            source_hash: "a".repeat(64),
            file_name: None,
            title: None,
            sender: None,
            category: Category::Jobcenter,
            doc_date: None,
            summary: None,
            facts: facts
                .into_iter()
                .map(|content| Fact {
                    content: content.to_string(),
                    importance: Importance::Medium,
                })
                .collect(),
            deadlines: vec![],
            obligations: vec![],
            addresses: vec![],
            amounts: vec![],
            tags: vec![],
            is_active: true,
            expiry_date: None,
        }
    }

    fn detail(kind: MatchKind, value: &str) -> PlantedDetail {
        PlantedDetail {
            id: "d".into(),
            label: "d".into(),
            kind,
            value: value.into(),
            tier: Tier::Model,
            beyond_cut: false,
        }
    }

    #[test]
    fn digits_match_ignores_phone_formatting() {
        let extraction = extraction_with(vec!["Kontakt (Telefon): 030 / 555-789 12."]);
        let haystack = Haystack::from_extraction(&extraction);
        assert!(is_found(&detail(MatchKind::Digits, "03055578912"), &haystack));
    }

    #[test]
    fn text_match_unifies_en_dash_and_hyphen() {
        // The source writes "9:00–12:00" (en dash); a paraphrase may use "-".
        let extraction = extraction_with(vec!["Sprechzeiten: Dienstag 9:00–12:00 Uhr."]);
        let haystack = Haystack::from_extraction(&extraction);
        assert!(is_found(
            &detail(MatchKind::Text, "dienstag 9:00-12:00"),
            &haystack
        ));
    }

    #[test]
    fn iso_date_matches_structured_field_and_german_rendering() {
        let mut extraction = extraction_with(vec![]);
        extraction.deadlines = vec![Deadline {
            label: "Widerspruch".into(),
            date: IsoDate("2027-01-15".into()),
            kind: None,
        }];
        let haystack = Haystack::from_extraction(&extraction);
        assert!(is_found(&detail(MatchKind::IsoDate, "2027-01-15"), &haystack));

        // Same date, only ever mentioned in German prose.
        let prose = extraction_with(vec!["Die Widerspruchsfrist endet am 15.01.2027."]);
        let prose_haystack = Haystack::from_extraction(&prose);
        assert!(is_found(
            &detail(MatchKind::IsoDate, "2027-01-15"),
            &prose_haystack
        ));
    }

    #[test]
    fn haystack_spans_every_field_not_just_facts() {
        // A value the model put in `amounts` must count as found even though
        // `facts` is empty — per-field scoring would call this a miss.
        let mut extraction = extraction_with(vec![]);
        extraction.amounts = vec![Amount {
            label: Some("Nachzahlung".into()),
            value: "1.842,50".into(),
            currency: Some("EUR".into()),
        }];
        let haystack = Haystack::from_extraction(&extraction);
        assert!(is_found(&detail(MatchKind::Text, "1.842,50"), &haystack));
    }

    #[test]
    fn recall_splits_by_tier_and_flags_leaks() {
        let expectation = FixtureExpectation {
            fixture: "f.txt".into(),
            category: "jobcenter".into(),
            note: String::new(),
            details: vec![
                PlantedDetail {
                    id: "kept".into(),
                    label: "kept".into(),
                    kind: MatchKind::Text,
                    value: "563,00".into(),
                    tier: Tier::Deterministic,
                    beyond_cut: false,
                },
                PlantedDetail {
                    id: "dropped".into(),
                    label: "dropped".into(),
                    kind: MatchKind::Text,
                    value: "9.999,00".into(),
                    tier: Tier::Model,
                    beyond_cut: true,
                },
            ],
            forbidden: vec![detail(MatchKind::Digits, "12345678901234567890")],
        };

        let extraction = extraction_with(vec![
            "Monatlich 563,00 Euro.",
            "Konto DE12 3456 7890 1234 5678 90.",
        ]);
        let report = score_fixture(&expectation, &extraction);

        assert_eq!(report.recall(Some(Tier::Deterministic)), 1.0);
        assert_eq!(report.recall(Some(Tier::Model)), 0.0);
        assert_eq!(report.recall(None), 0.5);
        assert_eq!(report.missing(Some(Tier::Model)).len(), 1);
        // The unmasked IBAN leaked — a privacy failure, not a recall miss.
        assert_eq!(report.leaked.len(), 1);
    }

    #[test]
    fn recall_matrix_surfaces_flaky_details() {
        let make = |found: bool| FixtureReport {
            fixture: "f.txt".into(),
            outcomes: vec![DetailOutcome {
                id: "bg".into(),
                label: "BG-Nummer".into(),
                tier: Tier::Model,
                beyond_cut: false,
                found,
            }],
            leaked: vec![],
        };
        // The historical 1-of-4 case: a single run would report pass or fail.
        let reports = vec![make(true), make(false), make(false), make(false)];
        let matrix = RecallMatrix::from_reports("f.txt", &reports);

        assert_eq!(matrix.runs, 4);
        assert_eq!(matrix.per_detail[0].4, 1);
        assert_eq!(matrix.flaky().len(), 1);
    }

    #[test]
    fn every_committed_expectation_file_parses() {
        let expectations = load_expectations().expect("eval/extraction/expected must be readable");
        assert!(
            expectations.len() >= 6,
            "expected at least 6 fixtures, got {}",
            expectations.len()
        );
        for expectation in &expectations {
            assert!(
                !expectation.details.is_empty(),
                "{} has no planted details",
                expectation.fixture
            );
            let fixture_path = eval_dir().join("fixtures").join(&expectation.fixture);
            assert!(
                fixture_path.exists(),
                "expectation references a missing fixture: {}",
                fixture_path.display()
            );
        }
    }
}
