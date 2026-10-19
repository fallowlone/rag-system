//! Tier 2 of the extraction-recall harness: the real model, N runs per
//! fixture, scored against the planted details in `eval/extraction/expected`.
//!
//! ```console
//! cargo run -p dokumente-core --features llama --example eval-extraction -- \
//!     /tmp/dokumente-eval/qwen3-8b.gguf --runs 5
//! ```
//!
//! Flags: `--runs N` (default 5), `--fixture <name>` to narrow, and
//! `--write-baseline` to record the current numbers as `baseline.json`.
//!
//! # Why N runs
//!
//! One run cannot measure this pipeline. The recorded history is "BG-Nummer
//! survived 0 of 4 runs, Berater phone 1 of 4" — a single pass reports
//! whichever side of that coin it landed on, which is how a brittle
//! extractor looked healthy for as long as it did. The headline number here
//! is therefore `found_runs / N` per planted detail, and the interesting
//! column is `flaky`: details the model finds sometimes.

use dokumente_core::eval::{
    eval_dir, load_expectations, score_fixture, FixtureExpectation, FixtureReport, RecallMatrix,
    Tier,
};
use dokumente_core::extraction::extract_text;
use dokumente_core::llm::runner::LlamaExtractor;
use dokumente_core::llm::Extractor;
use std::collections::BTreeMap;

struct Args {
    model_path: String,
    runs: usize,
    fixture: Option<String>,
    write_baseline: bool,
}

fn parse_args() -> Args {
    let mut args = std::env::args().skip(1);
    let model_path = args
        .next()
        .expect("usage: eval-extraction <model.gguf> [--runs N] [--fixture NAME] [--write-baseline]");
    let mut parsed = Args {
        model_path,
        runs: 5,
        fixture: None,
        write_baseline: false,
    };
    while let Some(flag) = args.next() {
        match flag.as_str() {
            "--runs" => {
                parsed.runs = args
                    .next()
                    .and_then(|v| v.parse().ok())
                    .expect("--runs needs a positive integer");
                assert!(parsed.runs > 0, "--runs must be at least 1");
            }
            "--fixture" => parsed.fixture = args.next(),
            "--write-baseline" => parsed.write_baseline = true,
            other => panic!("unknown flag: {other}"),
        }
    }
    // The baseline is written as a whole file. Recording it from a filtered
    // run would silently drop every other fixture from it, and the next full
    // run would then report "improved" against a baseline that no longer
    // remembers what the others scored.
    assert!(
        !(parsed.write_baseline && parsed.fixture.is_some()),
        "--write-baseline records the whole baseline and cannot be combined with --fixture"
    );
    parsed
}

/// A run that errored is a run that found nothing — a hard extraction
/// failure (truncated JSON, hash mismatch) is a recall failure, not an
/// excuse to drop the sample.
fn all_missing(expectation: &FixtureExpectation) -> FixtureReport {
    FixtureReport {
        fixture: expectation.fixture.clone(),
        outcomes: expectation
            .details
            .iter()
            .map(|d| dokumente_core::eval::DetailOutcome {
                id: d.id.clone(),
                label: d.label.clone(),
                tier: d.tier,
                beyond_cut: d.beyond_cut,
                found: false,
            })
            .collect(),
        leaked: vec![],
    }
}

fn main() {
    let args = parse_args();
    let expectations: Vec<FixtureExpectation> = load_expectations()
        .expect("eval/extraction/expected must be readable")
        .into_iter()
        .filter(|e| args.fixture.as_ref().is_none_or(|f| &e.fixture == f))
        .collect();
    assert!(!expectations.is_empty(), "no fixtures matched");

    println!("loading model {} …", args.model_path);
    let extractor = LlamaExtractor::load(std::path::Path::new(&args.model_path))
        .expect("model load failed");

    let mut matrices: Vec<RecallMatrix> = Vec::new();
    let mut failures: BTreeMap<String, usize> = BTreeMap::new();

    for expectation in &expectations {
        let path = eval_dir().join("fixtures").join(&expectation.fixture);
        let bytes = std::fs::read(&path).expect("fixture unreadable");
        let source_hash = dokumente_core::source_hash(&bytes);
        let extracted = extract_text(&path).expect("fixture extraction failed");

        println!(
            "\n=== {} ({} chars, {} runs) ===",
            expectation.fixture,
            extracted.text.chars().count(),
            args.runs
        );

        let mut reports = Vec::with_capacity(args.runs);
        for run in 1..=args.runs {
            let started = std::time::Instant::now();
            match extractor.extract(&source_hash, &extracted.text) {
                Ok(outcome) => {
                    let extraction = outcome.extraction;
                    let report = score_fixture(expectation, &extraction);
                    println!(
                        "  run {run}/{}  det {:.0}%  model {:.0}%  ({:.1?})",
                        args.runs,
                        report.recall(Some(Tier::Deterministic)) * 100.0,
                        report.recall(Some(Tier::Model)) * 100.0,
                        started.elapsed()
                    );
                    if !report.leaked.is_empty() {
                        println!("    LEAK: {:?}", report.leaked);
                    }
                    reports.push(report);
                }
                Err(err) => {
                    println!("  run {run}/{} FAILED: {err}", args.runs);
                    *failures.entry(expectation.fixture.clone()).or_insert(0) += 1;
                    reports.push(all_missing(expectation));
                }
            }
        }

        let matrix = RecallMatrix::from_reports(&expectation.fixture, &reports);
        print_matrix(&matrix);
        matrices.push(matrix);
    }

    print_summary(&matrices, &failures);

    let json = to_json(&matrices);
    let results_dir = eval_dir().join("results");
    let _ = std::fs::create_dir_all(&results_dir);
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let out_path = results_dir.join(format!("run-{stamp}.json"));
    if let Err(err) = std::fs::write(&out_path, &json) {
        eprintln!("could not write {}: {err}", out_path.display());
    } else {
        println!("\nresults written to {}", out_path.display());
    }

    if args.write_baseline {
        let baseline = eval_dir().join("baseline.json");
        std::fs::write(&baseline, &json).expect("could not write baseline");
        println!("baseline updated: {}", baseline.display());
    } else {
        compare_to_baseline(&matrices);
    }
}

fn print_matrix(matrix: &RecallMatrix) {
    println!("  --- per-detail, found in N of {} runs ---", matrix.runs);
    for (_, label, tier, beyond_cut, found) in &matrix.per_detail {
        let tier_label = match tier {
            Tier::Deterministic => "det  ",
            Tier::Model => "model",
        };
        let cut = if *beyond_cut { "  [beyond 24k cut]" } else { "" };
        let bar = if *found == matrix.runs {
            "OK  "
        } else if *found == 0 {
            "GONE"
        } else {
            "FLAK"
        };
        println!("    {bar} {tier_label} {found}/{}  {label}{cut}", matrix.runs);
    }
    let flaky = matrix.flaky();
    if !flaky.is_empty() {
        println!(
            "  {} detail(s) are FLAKY — found in some runs, lost in others",
            flaky.len()
        );
    }
}

fn print_summary(matrices: &[RecallMatrix], failures: &BTreeMap<String, usize>) {
    println!("\n================ SUMMARY ================");
    let mut model_found = 0usize;
    let mut model_total = 0usize;
    let mut cut_found = 0usize;
    let mut cut_total = 0usize;
    let mut det_lost: Vec<String> = Vec::new();
    let mut flaky_total = 0usize;

    for matrix in matrices {
        for (_, label, tier, beyond_cut, found) in &matrix.per_detail {
            match tier {
                Tier::Model => {
                    model_found += found;
                    model_total += matrix.runs;
                    if *beyond_cut {
                        cut_found += found;
                        cut_total += matrix.runs;
                    }
                }
                Tier::Deterministic => {
                    if *found < matrix.runs {
                        det_lost.push(format!("{} / {label} ({found}/{})", matrix.fixture, matrix.runs));
                    }
                }
            }
        }
        flaky_total += matrix.flaky().len();
    }

    let pct = |found: usize, total: usize| {
        if total == 0 {
            100.0
        } else {
            found as f64 / total as f64 * 100.0
        }
    };

    println!("model recall (all runs)        : {:.1}%", pct(model_found, model_total));
    if cut_total > 0 {
        println!(
            "model recall beyond the 24k cut: {:.1}%   <- what A2 (multi-pass) would recover",
            pct(cut_found, cut_total)
        );
    }
    println!("flaky details                  : {flaky_total}");
    if !failures.is_empty() {
        println!("hard extraction failures       : {failures:?}");
    }
    if det_lost.is_empty() {
        println!("deterministic guarantees       : all held");
    } else {
        println!("deterministic guarantees BROKEN:");
        for entry in &det_lost {
            println!("  - {entry}");
        }
    }
}

fn to_json(matrices: &[RecallMatrix]) -> String {
    let entries: Vec<serde_json::Value> = matrices
        .iter()
        .map(|matrix| {
            let details: Vec<serde_json::Value> = matrix
                .per_detail
                .iter()
                .map(|(id, label, tier, beyond_cut, found)| {
                    serde_json::json!({
                        "id": id,
                        "label": label,
                        "tier": match tier { Tier::Deterministic => "deterministic", Tier::Model => "model" },
                        "beyondCut": beyond_cut,
                        "foundRuns": found,
                    })
                })
                .collect();
            serde_json::json!({
                "fixture": matrix.fixture,
                "runs": matrix.runs,
                "details": details,
            })
        })
        .collect();
    serde_json::to_string_pretty(&serde_json::json!({ "fixtures": entries }))
        .expect("serialization failed")
}

/// Reports any detail whose hit rate dropped against the committed baseline.
/// Absence of a baseline is not an error — the first run creates one.
fn compare_to_baseline(matrices: &[RecallMatrix]) {
    let path = eval_dir().join("baseline.json");
    let Ok(raw) = std::fs::read_to_string(&path) else {
        println!("\nno baseline.json yet — re-run with --write-baseline to record one");
        return;
    };
    let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw) else {
        eprintln!("baseline.json is not valid JSON — ignoring");
        return;
    };

    let mut previous: BTreeMap<(String, String), (usize, usize)> = BTreeMap::new();
    if let Some(fixtures) = parsed.get("fixtures").and_then(|f| f.as_array()) {
        for fixture in fixtures {
            let name = fixture.get("fixture").and_then(|f| f.as_str()).unwrap_or("");
            let runs = fixture.get("runs").and_then(|r| r.as_u64()).unwrap_or(0) as usize;
            if let Some(details) = fixture.get("details").and_then(|d| d.as_array()) {
                for detail in details {
                    let id = detail.get("id").and_then(|i| i.as_str()).unwrap_or("");
                    let found = detail.get("foundRuns").and_then(|f| f.as_u64()).unwrap_or(0) as usize;
                    previous.insert((name.to_string(), id.to_string()), (found, runs));
                }
            }
        }
    }

    let mut regressions: Vec<String> = Vec::new();
    let mut improvements = 0usize;
    for matrix in matrices {
        for (id, label, _, _, found) in &matrix.per_detail {
            let Some((base_found, base_runs)) = previous.get(&(matrix.fixture.clone(), id.clone()))
            else {
                continue;
            };
            if *base_runs == 0 || matrix.runs == 0 {
                continue;
            }
            let now = *found as f64 / matrix.runs as f64;
            let before = *base_found as f64 / *base_runs as f64;
            if now < before - 0.001 {
                regressions.push(format!(
                    "{} / {label}: {:.0}% -> {:.0}%",
                    matrix.fixture,
                    before * 100.0,
                    now * 100.0
                ));
            } else if now > before + 0.001 {
                improvements += 1;
            }
        }
    }

    println!("\n--- vs baseline.json ---");
    println!("improved: {improvements}");
    if regressions.is_empty() {
        println!("regressions: none");
    } else {
        println!("REGRESSIONS ({}):", regressions.len());
        for entry in &regressions {
            println!("  - {entry}");
        }
    }
}
