use super::*;

// Note: grammar enforcement is verified empirically by
// `cargo run --features llama --example smoke -- <model.gguf>` — llguidance
// 1.7's Matcher has no offline validate API usable without a real tokenizer.
// The schema-shape tests below pin the contract that the grammar enforces.

#[test]
fn chatml_prompt_is_wellformed() {
    let hash = "b".repeat(64);
    let prompt = build_chatml_prompt(&hash, "Mietvertrag über 800 EUR");
    assert!(prompt.starts_with("<|im_start|>system\n"));
    assert!(prompt.contains("/no_think"));
    assert!(prompt.contains(&hash));
    assert!(prompt.contains("Mietvertrag"));
    assert!(prompt.ends_with("<|im_start|>assistant\n"));
    // system + user + assistant blocks all opened correctly, user+system closed
    assert_eq!(prompt.matches("<|im_start|>").count(), 3);
    assert_eq!(prompt.matches("<|im_end|>").count(), 2);
}

#[test]
fn json_schema_matches_backend_contract() {
    let schema: serde_json::Value = serde_json::from_str(EXTRACTION_JSON_SCHEMA).unwrap();
    let props = schema["properties"].as_object().unwrap();
    for field in [
        "sourceHash",
        "category",
        "facts",
        "deadlines",
        "obligations",
        "addresses",
        "amounts",
        "tags",
        "isActive",
    ] {
        assert!(props.contains_key(field), "schema missing {field}");
    }
    let required = schema["required"].as_array().unwrap();
    assert!(required.contains(&serde_json::json!("sourceHash")));
    assert!(required.contains(&serde_json::json!("category")));
    assert!(required.contains(&serde_json::json!("isActive")));

    // Category enum matches the backend Zod enum exactly
    let categories: Vec<&str> = schema["properties"]["category"]["enum"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap())
        .collect();
    assert_eq!(
        categories,
        [
            "mietvertrag",
            "jobcenter",
            "bank",
            "visa",
            "versicherung",
            "other"
        ]
    );

    // The minimal extraction the grammar must accept round-trips through
    // the serde types (same shape the backend Zod `.default([])` accepts).
    let minimal = serde_json::json!({
        "sourceHash": "f".repeat(64),
        "category": "other",
        "isActive": true
    });
    let parsed: Extraction = serde_json::from_value(minimal).unwrap();
    assert_eq!(parsed.category, crate::types::Category::Other);
}

#[test]
fn json_schema_enforces_backend_size_caps() {
    // Transcribed from the Zod `.max()`/`.min()`/`.max(n)` bounds in
    // src/app-api/app-documents.controller.ts: an oversized but
    // shape-valid payload must be unrepresentable, otherwise the backend
    // 400s it and the document parks as permanently failed.
    let schema: serde_json::Value = serde_json::from_str(EXTRACTION_JSON_SCHEMA).unwrap();
    let props = schema["properties"].as_object().unwrap();
    for (array, max_items) in [
        ("facts", 50),
        ("deadlines", 20),
        ("obligations", 20),
        ("addresses", 10),
        ("amounts", 20),
        ("tags", 10),
    ] {
        assert_eq!(
            props[array]["maxItems"], max_items,
            "schema lost maxItems for {array}"
        );
    }
    assert_eq!(
        props["facts"]["items"]["properties"]["content"]["maxLength"],
        1000
    );
    assert_eq!(
        props["facts"]["items"]["properties"]["content"]["minLength"],
        1
    );
    assert_eq!(props["summary"]["maxLength"], 2000);
    assert_eq!(props["title"]["maxLength"], 300);
    assert_eq!(props["tags"]["items"]["maxLength"], 40);
}

#[test]
fn system_prompt_from_contract_is_embedded() {
    // The runner must use the same system prompt as the documented
    // contract in llm/mod.rs (privacy filter included).
    let prompt = build_chatml_prompt(&"a".repeat(64), "x");
    assert!(prompt.contains("NICHT speichern"));
}

#[test]
fn fit_doc_chars_keeps_everything_within_budget() {
    assert_eq!(fit_doc_chars(24_000, 6_000, 6_144), 24_000);
    assert_eq!(fit_doc_chars(100, 50, 5_000), 100);
}

#[test]
fn fit_doc_chars_cuts_proportionally_with_safety_margin() {
    // Half the budget → half the chars minus 5%.
    assert_eq!(fit_doc_chars(24_000, 10_000, 5_000), 11_400);
}

#[test]
fn fit_doc_chars_never_returns_zero() {
    assert_eq!(fit_doc_chars(24_000, 100_000, 0), 1);
    assert_eq!(fit_doc_chars(24_000, 100_000, 1), 1);
}

#[test]
fn visible_doc_chars_reports_what_the_prompt_carried_not_the_document() {
    assert_eq!(visible_doc_chars(&"x".repeat(1_000)), 1_000);
    // build_user_prompt caps the document, so anything longer contributes
    // exactly MAX_PROMPT_DOC_CHARS of text to the measured prompt — the
    // token count describes the cap, not the document.
    assert_eq!(
        visible_doc_chars(&"x".repeat(MAX_PROMPT_DOC_CHARS + 2_466)),
        MAX_PROMPT_DOC_CHARS
    );
    // Multi-byte safety: the cap counts chars, not bytes.
    assert_eq!(visible_doc_chars(&"ü".repeat(10)), 10);
}

#[test]
fn over_cap_documents_get_a_real_cut_not_a_no_op() {
    // Reproduces the measured failure. long-bescheid.txt is 26,466 chars;
    // its first MAX_PROMPT_DOC_CHARS tokenize to roughly 6,000 document
    // tokens against a ~5,724-token document budget (8192 context, 2048
    // reserved for output, minus template overhead).
    let full_chars = 26_466;
    let doc_tokens = 6_000;
    let budget = 5_724;

    // The defect: scaling from the FULL length applies a ratio derived from
    // the capped text to a larger base, landing within a rounding error of
    // the cap. build_user_prompt then re-caps it, so the "truncated" prompt
    // is byte-identical to the one that just overflowed — and the extraction
    // failed outright, 5 runs of 5.
    let scaled_from_full_length = fit_doc_chars(full_chars, doc_tokens, budget);
    assert!(
        scaled_from_full_length > MAX_PROMPT_DOC_CHARS - 100,
        "the old argument must be shown to produce a no-op cut, got {scaled_from_full_length}"
    );

    // The fix: scale from the chars the prompt actually carried.
    let visible = visible_doc_chars(&"x".repeat(full_chars));
    let cut = next_keep(visible, doc_tokens, budget);
    assert!(
        cut < MAX_PROMPT_DOC_CHARS * 96 / 100,
        "the cut must materially shrink the prompt, got {cut}"
    );
}

#[test]
fn next_keep_always_shrinks_even_when_the_ratio_is_a_no_op() {
    // doc_tokens == budget makes fit_doc_chars the identity, while the
    // caller's fit check needs strictly-less: without a forced step the loop
    // would re-tokenize the same prompt until it ran out of attempts.
    assert!(next_keep(1_000, 5_724, 5_724) < 1_000);
    assert!(next_keep(20, 100, 10) < 20);
    // Degenerate input terminates instead of spinning.
    assert_eq!(next_keep(1, 100, 0), 0);
}


#[test]
fn a_short_document_is_a_single_window_covering_all_of_it() {
    let raw = "ä".repeat(MAX_PROMPT_DOC_CHARS - 1);
    let (windows, covered) = split_windows(&raw);
    assert_eq!(windows.len(), 1);
    // Characters, not bytes: every umlaut is two bytes and would double-count.
    assert_eq!(covered, MAX_PROMPT_DOC_CHARS - 1);
    assert_eq!(windows[0], raw);
}

#[test]
fn exactly_one_window_at_the_cap() {
    let raw = "x".repeat(MAX_PROMPT_DOC_CHARS);
    let (windows, covered) = split_windows(&raw);
    assert_eq!(windows.len(), 1);
    assert_eq!(covered, MAX_PROMPT_DOC_CHARS);
}

#[test]
fn a_long_document_is_split_with_overlap_and_full_coverage() {
    // One character past the cap must still be read, not dropped: this is
    // the regression that made everything past ~24k invisible to the model.
    let raw = "x".repeat(MAX_PROMPT_DOC_CHARS + 1);
    let (windows, covered) = split_windows(&raw);
    assert_eq!(windows.len(), 2);
    assert_eq!(covered, MAX_PROMPT_DOC_CHARS + 1);
    assert_eq!(windows[0].chars().count(), MAX_PROMPT_DOC_CHARS);
    // The second window starts inside the first, so a detail sitting on the
    // boundary is whole in at least one of them.
    assert!(windows[1].chars().count() > WINDOW_OVERLAP_CHARS);
}

#[test]
fn windows_overlap_by_the_declared_amount() {
    let raw: String = (0..60_000).map(|i| char::from(b'a' + (i % 26) as u8)).collect();
    let (windows, _) = split_windows(&raw);
    assert!(windows.len() >= 2);
    let first: Vec<char> = windows[0].chars().collect();
    let second: Vec<char> = windows[1].chars().collect();
    let tail: String = first[first.len() - WINDOW_OVERLAP_CHARS..].iter().collect();
    let head: String = second[..WINDOW_OVERLAP_CHARS].iter().collect();
    assert_eq!(tail, head);
}

#[test]
fn passes_are_bounded_and_coverage_says_what_was_left_out() {
    // Each window is a full local inference, so coverage is traded against
    // time explicitly rather than growing without limit.
    let stride = MAX_PROMPT_DOC_CHARS - WINDOW_OVERLAP_CHARS;
    let huge = "x".repeat(stride * (MAX_PASSES + 5));
    let (windows, covered) = split_windows(&huge);
    assert_eq!(windows.len(), MAX_PASSES);
    assert!(
        covered < huge.chars().count(),
        "a document past the pass budget must report partial coverage"
    );
    // Coverage is the true reach of the last window, not a round number.
    assert_eq!(covered, stride * (MAX_PASSES - 1) + MAX_PROMPT_DOC_CHARS);
}

#[test]
fn empty_input_produces_one_window_and_no_coverage() {
    let (windows, covered) = split_windows("");
    assert_eq!(windows.len(), 1);
    assert_eq!(covered, 0);
}
