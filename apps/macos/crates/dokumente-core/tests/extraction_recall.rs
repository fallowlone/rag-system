//! Tier 1 of the extraction-recall harness: deterministic, no model, CI gate.
//!
//! Every fixture is run through the real `extract_text` path and then through
//! `ensure_key_details` on top of an EMPTY extraction — i.e. the worst case
//! where the local model returned nothing usable. Whatever the backstop
//! claims to guarantee must survive that, on every fixture, every time.
//!
//! Tier 2 (the real model, N runs, stochastic recall) lives in
//! `examples/eval-extraction.rs` and cannot run in CI: it needs a ~4.8 GB
//! GGUF and the `llama` feature.
//!
//! ```console
//! cargo test -p dokumente-core --test extraction_recall -- --nocapture
//! ```

use dokumente_core::eval::{
    eval_dir, load_expectations, score_fixture, FixtureReport, Tier,
};
use dokumente_core::extraction::extract_text;
use dokumente_core::llm::ensure_key_details;
use dokumente_core::types::{Category, Extraction, Fact, Importance};

/// The worst case the backstop must cope with: a model that produced nothing.
fn empty_extraction() -> Extraction {
    Extraction {
        source_hash: "0".repeat(64),
        file_name: None,
        title: None,
        sender: None,
        category: Category::Other,
        doc_date: None,
        summary: None,
        facts: vec![],
        deadlines: vec![],
        obligations: vec![],
        addresses: vec![],
        amounts: vec![],
        tags: vec![],
        is_active: true,
        expiry_date: None,
    }
}

fn render(report: &FixtureReport) -> String {
    let mut out = format!("\n  {}\n", report.fixture);
    for outcome in &report.outcomes {
        let mark = if outcome.found { "PASS" } else { "MISS" };
        let tier = match outcome.tier {
            Tier::Deterministic => "det ",
            Tier::Model => "model",
        };
        let cut = if outcome.beyond_cut { " [beyond 24k cut]" } else { "" };
        out.push_str(&format!(
            "    {mark}  {tier}  {:<40}{cut}\n",
            outcome.label
        ));
    }
    out.push_str(&format!(
        "    -> deterministic recall {:.0}%   model recall {:.0}% (informational)\n",
        report.recall(Some(Tier::Deterministic)) * 100.0,
        report.recall(Some(Tier::Model)) * 100.0,
    ));
    out
}

#[test]
fn deterministic_details_survive_an_empty_model_extraction() {
    let expectations = load_expectations().expect("eval/extraction/expected must be readable");
    let mut failures: Vec<String> = Vec::new();
    let mut transcript = String::new();

    for expectation in &expectations {
        let path = eval_dir().join("fixtures").join(&expectation.fixture);
        let extracted = extract_text(&path)
            .unwrap_or_else(|err| panic!("{}: extraction failed: {err}", expectation.fixture));

        let mut extraction = empty_extraction();
        ensure_key_details(&extracted.text, &mut extraction);

        let report = score_fixture(expectation, &extraction);
        transcript.push_str(&render(&report));

        for missing in report.missing(Some(Tier::Deterministic)) {
            failures.push(format!(
                "{}: deterministic detail not recovered by ensure_key_details: {} ({})",
                expectation.fixture, missing.label, missing.id
            ));
        }
        for leak in &report.leaked {
            failures.push(format!("{}: forbidden value leaked: {leak}", expectation.fixture));
        }
    }

    println!("{transcript}");
    assert!(
        failures.is_empty(),
        "Tier 1 recall gate failed:\n  - {}",
        failures.join("\n  - ")
    );
}

/// The backstop reads the FULL text while the model only sees the first
/// `MAX_PROMPT_DOC_CHARS`. On the long fixture that asymmetry is the whole
/// point: deterministic details in the tail must still be recovered.
#[test]
fn backstop_recovers_details_past_the_prompt_cut() {
    let expectations = load_expectations().expect("expectations must load");
    let long = expectations
        .iter()
        .find(|e| e.fixture == "long-bescheid.txt")
        .expect("long-bescheid.txt expectation must exist");

    let beyond_cut_deterministic = long
        .details
        .iter()
        .filter(|d| d.beyond_cut && d.tier == Tier::Deterministic)
        .count();
    assert!(
        beyond_cut_deterministic >= 3,
        "the long fixture must plant deterministic details past the cut, found {beyond_cut_deterministic}"
    );

    let path = eval_dir().join("fixtures").join(&long.fixture);
    let extracted = extract_text(&path).expect("long fixture must extract");
    assert!(
        extracted.text.chars().count() > 24_000,
        "the long fixture must exceed MAX_PROMPT_DOC_CHARS after normalization"
    );

    let mut extraction = empty_extraction();
    ensure_key_details(&extracted.text, &mut extraction);
    let report = score_fixture(long, &extraction);

    let missed_tail: Vec<&str> = report
        .outcomes
        .iter()
        .filter(|o| o.beyond_cut && o.tier == Tier::Deterministic && !o.found)
        .map(|o| o.label.as_str())
        .collect();
    assert!(
        missed_tail.is_empty(),
        "deterministic details past the prompt cut were lost: {missed_tail:?}"
    );
}

/// `mask_ibans` is a privacy invariant: the model is told never to emit an
/// IBAN, and when it does anyway the backstop must remove it before the
/// extraction reaches the server.
#[test]
fn ibans_emitted_by_the_model_are_masked_before_scoring() {
    let expectations = load_expectations().expect("expectations must load");
    let bank = expectations
        .iter()
        .find(|e| e.fixture == "bank-dispo.txt")
        .expect("bank-dispo.txt expectation must exist");
    assert!(
        !bank.forbidden.is_empty(),
        "the bank fixture must declare the IBAN as forbidden"
    );

    let path = eval_dir().join("fixtures").join(&bank.fixture);
    let extracted = extract_text(&path).expect("bank fixture must extract");

    // Simulate the failure the prompt bans and the backstop repairs.
    let mut extraction = empty_extraction();
    extraction.facts.push(Fact {
        content: "Das Girokonto DE12 3456 7890 1234 5678 90 ist überzogen.".into(),
        importance: Importance::High,
    });
    ensure_key_details(&extracted.text, &mut extraction);

    let report = score_fixture(bank, &extraction);
    assert!(
        report.leaked.is_empty(),
        "an unmasked IBAN survived into the extraction: {:?}",
        report.leaked
    );
}
