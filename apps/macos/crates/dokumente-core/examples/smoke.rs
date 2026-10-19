//! Smoke test for the llama.cpp runner: loads a real GGUF model and runs one
//! grammar-constrained extraction. Content quality depends on the model;
//! the PASS criterion is mechanical — schema-conformant JSON output.
//!
//! ```console
//! cargo run -p dokumente-core --features llama --example smoke -- <model.gguf>
//! ```

use dokumente_core::llm::parse_extraction;
use dokumente_core::llm::runner::LlamaExtractor;

fn main() {
    let model_path = std::env::args().nth(1).expect("usage: smoke <model.gguf>");
    let source_hash = "c0ffee".repeat(10).to_string() + "1234"; // 64 hex chars
    assert_eq!(source_hash.len(), 64);

    let document = "Jobcenter Berlin Mitte\nBewilligungsbescheid Bürgergeld\n\
        Bewilligt ab 01.10.2026 monatlich 563 EUR.\n\
        Widerspruchsfrist: 14.10.2026\n\
        Bitte reichen Sie die Nachweise bis 30.09.2026 ein.";

    println!("loading model {model_path} …");
    let extractor =
        LlamaExtractor::load(std::path::Path::new(&model_path)).expect("model load failed");

    println!("running grammar-constrained extraction …");
    let start = std::time::Instant::now();
    let completion = extractor
        .complete(&source_hash, document)
        .expect("extraction failed");
    let elapsed = start.elapsed();
    let json = completion.text;

    println!(
        "--- raw output ({elapsed:.1?}, truncated={}) ---",
        completion.truncated
    );
    println!("{json}");
    println!("--- end ---");

    match parse_extraction(&json) {
        Ok(extraction) => {
            println!(
                "PARSE OK — category: {:?}, facts: {}, deadlines: {}, hash_matches: {}",
                extraction.category,
                extraction.facts.len(),
                extraction.deadlines.len(),
                extraction.source_hash == source_hash,
            );
        }
        Err(err) => {
            eprintln!("PARSE FAILED: {err}");
            std::process::exit(1);
        }
    }
}
