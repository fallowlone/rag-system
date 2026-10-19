//! llama.cpp runner: local, offline, grammar-constrained extraction.
//!
//! Built only with the `llama` feature (needs cmake + C++ toolchain).
//! Constrained decoding uses LLGuidance with a JSON Schema that mirrors the
//! backend Zod validation — the model physically cannot emit JSON that the
//! server would reject on shape grounds.

use crate::error::{CoreError, Result};
use crate::llm::{
    build_user_prompt, parse_extraction, ExtractionOutcome, Extractor, EXTRACTION_SYSTEM_PROMPT,
    MAX_PROMPT_DOC_CHARS,
};
use crate::types::Extraction;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::LlamaToken;

#[cfg(test)]
mod runner_tests;

/// JSON Schema for the extraction — the single source of truth is the
/// backend Zod schema (src/app-api/app-documents.controller.ts); this is its
/// JSON-Schema transcription, used for LLGuidance-constrained decoding.
/// Size caps (maxItems/maxLength/minLength) are transcribed too: without
/// them the model can emit a shape-valid but oversized payload that the
/// backend rejects with 400 — and a 400 parks the document as permanently
/// failed with no recovery path (re-extraction emits the same oversize).
const EXTRACTION_JSON_SCHEMA: &str = r##"{
  "type": "object",
  "properties": {
    "sourceHash": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
    "fileName": { "type": "string", "minLength": 1, "maxLength": 255 },
    "title": { "type": "string", "minLength": 1, "maxLength": 300 },
    "sender": { "type": "string", "minLength": 1, "maxLength": 200 },
    "category": { "enum": ["mietvertrag", "jobcenter", "bank", "visa", "versicherung", "other"] },
    "docDate": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
    "summary": { "type": "string", "minLength": 1, "maxLength": 2000 },
    "facts": {
      "type": "array",
      "maxItems": 50,
      "items": {
        "type": "object",
        "properties": {
          "content": { "type": "string", "minLength": 1, "maxLength": 1000 },
          "importance": { "enum": ["high", "medium", "low"] }
        },
        "required": ["content", "importance"],
        "additionalProperties": false
      }
    },
    "deadlines": {
      "type": "array",
      "maxItems": 20,
      "items": {
        "type": "object",
        "properties": {
          "label": { "type": "string", "minLength": 1, "maxLength": 200 },
          "date": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" },
          "kind": { "type": "string", "minLength": 1, "maxLength": 60 }
        },
        "required": ["label", "date"],
        "additionalProperties": false
      }
    },
    "obligations": { "type": "array", "maxItems": 20, "items": { "type": "string", "minLength": 1, "maxLength": 300 } },
    "addresses": {
      "type": "array",
      "maxItems": 10,
      "items": {
        "type": "object",
        "properties": {
          "purpose": { "type": "string", "minLength": 1, "maxLength": 100 },
          "address": { "type": "string", "minLength": 1, "maxLength": 300 }
        },
        "required": ["address"],
        "additionalProperties": false
      }
    },
    "amounts": {
      "type": "array",
      "maxItems": 20,
      "items": {
        "type": "object",
        "properties": {
          "label": { "type": "string", "minLength": 1, "maxLength": 100 },
          "value": { "type": "string", "minLength": 1, "maxLength": 50 },
          "currency": { "type": "string", "minLength": 1, "maxLength": 10 }
        },
        "required": ["value"],
        "additionalProperties": false
      }
    },
    "tags": { "type": "array", "maxItems": 10, "items": { "type": "string", "minLength": 1, "maxLength": 40 } },
    "isActive": { "type": "boolean" },
    "expiryDate": { "type": "string", "pattern": "^\\d{4}-\\d{2}-\\d{2}$" }
  },
  "required": ["sourceHash", "category", "isActive"],
  "additionalProperties": false
}"##;

/// Context window for extraction. The prompt is bounded by
/// MAX_PROMPT_DOC_CHARS + overhead; 8k leaves generous room for output.
const N_CTX: u32 = 8192;
/// Maximum generated tokens — the JSON extraction is a few hundred tokens.
const MAX_NEW_TOKENS: u32 = 2048;
/// Batch size for prompt processing.
const N_BATCH: u32 = 1024;

/// Re-tokenization can undershoot the proportional estimate (multi-byte
/// boundaries, the truncation marker), so the fit is iterative rather than
/// one-shot: a single bad estimate used to be a hard extraction failure.
const MAX_FIT_ATTEMPTS: usize = 4;

/// Windows a long document is extracted in (A2). One pass sees at most
/// `MAX_PROMPT_DOC_CHARS`; everything past that used to be invisible to the
/// model — measured on `long-bescheid.txt` as 0/5 for every beyond-cut
/// detail, on every run, while the deterministic backstop (which reads the
/// full text) recovered its own 3/3.
///
/// Bounded rather than unbounded: each pass is a full local inference, so
/// coverage is traded against time explicitly. Four windows cover ~94k
/// characters; beyond that the document stays partially covered and says so.
const MAX_PASSES: usize = 4;

/// Characters repeated at each window boundary. A detail split across a cut
/// ("Widerspruchsfrist endet am\n01.05.2026") is whole in at least one
/// window; the duplicate that produces is removed by `merge_extraction`.
const WINDOW_OVERLAP_CHARS: usize = 600;

/// Splits a document into overlapping extraction windows and reports how many
/// characters they cover in total.
///
/// Coverage is returned rather than recomputed by the caller because it is
/// capped by `MAX_PASSES`: for a long enough document the windows stop before
/// the end, and the difference is exactly what the UI has to disclose.
fn split_windows(raw_text: &str) -> (Vec<String>, usize) {
    let chars: Vec<char> = raw_text.chars().collect();
    if chars.len() <= MAX_PROMPT_DOC_CHARS {
        return (vec![raw_text.to_string()], chars.len());
    }
    let stride = MAX_PROMPT_DOC_CHARS - WINDOW_OVERLAP_CHARS;
    let mut windows = Vec::new();
    let mut start = 0;
    let mut covered = 0;
    while start < chars.len() && windows.len() < MAX_PASSES {
        let end = (start + MAX_PROMPT_DOC_CHARS).min(chars.len());
        windows.push(chars[start..end].iter().collect());
        covered = end;
        if end == chars.len() {
            break;
        }
        start += stride;
    }
    (windows, covered)
}

/// Chars of document text to keep so the tokenized prompt fits `budget`
/// tokens for the document part: proportional cut with a 5% safety margin
/// for boundary re-tokenization effects. Pure arithmetic — unit-tested;
/// the caller re-tokenizes to verify the fit.
///
/// `doc_chars` MUST be the number of document chars that actually reached
/// the measured prompt — see `visible_doc_chars`. Passing the full document
/// length scales a ratio derived from the capped text by a larger base, and
/// the result lands back at the cap.
fn fit_doc_chars(doc_chars: usize, doc_tokens: u64, budget: u64) -> usize {
    if doc_tokens <= budget {
        return doc_chars;
    }
    let ratio = budget as f64 / doc_tokens as f64;
    ((doc_chars as f64 * ratio * 0.95) as usize).max(1)
}

/// Document chars that actually reach the prompt. `build_user_prompt` caps
/// the document at `MAX_PROMPT_DOC_CHARS`, so for anything longer the
/// measured token count describes the CAP, not the document — and a cut
/// computed from the full length is a cut of text the model never saw.
///
/// Getting this wrong made every document past ~26k chars unextractable:
/// the recomputed `keep` came back at the cap, `build_user_prompt` re-capped
/// it, and the "truncated" prompt was byte-identical to the one that had
/// just overflowed — a no-op cut, then a hard error. Measured 5/5 runs on
/// `eval/extraction/fixtures/long-bescheid.txt` before the fix.
fn visible_doc_chars(raw_text: &str) -> usize {
    raw_text.chars().count().min(MAX_PROMPT_DOC_CHARS)
}

/// One fit iteration. Always returns strictly fewer chars than `current`,
/// which the proportional cut alone does not guarantee: when `doc_tokens`
/// equals `budget` exactly `fit_doc_chars` is the identity, while the
/// caller's fit check needs strictly-less — so a pure ratio could iterate
/// without ever shrinking the prompt.
fn next_keep(current: usize, doc_tokens: u64, budget: u64) -> usize {
    let proposed = fit_doc_chars(current, doc_tokens, budget);
    if proposed < current {
        proposed
    } else {
        current.saturating_sub(1).min(current * 95 / 100)
    }
}

/// ChatML prompt — the target models (Qwen3) use this template. Built
/// deterministically instead of via the model's chat template so the exact
/// prompt is testable and stable across model versions. `/no_think`
/// disables Qwen3's thinking blocks for extraction (we need pure JSON).
fn build_chatml_prompt(source_hash: &str, raw_text: &str) -> String {
    format!(
        "<|im_start|>system\n{EXTRACTION_SYSTEM_PROMPT}<|im_end|>\n\
         <|im_start|>user\n/no_think\n{}<|im_end|>\n\
         <|im_start|>assistant\n",
        build_user_prompt(source_hash, raw_text)
    )
}

/// Loaded llama.cpp model + backend. Cheap to reuse across extractions.
///
/// Not `Sync` (llama.cpp contexts are single-threaded) — wrap in a Mutex
/// when shared across Tauri command threads.
pub struct LlamaExtractor {
    #[allow(dead_code)] // the backend must outlive the model
    backend: LlamaBackend,
    model: LlamaModel,
    n_ctx: u32,
}

impl LlamaExtractor {
    /// Loads a GGUF model file. Fails with a descriptive CoreError.
    pub fn load(model_path: &std::path::Path) -> Result<Self> {
        let backend = LlamaBackend::init().map_err(|err| CoreError::ExtractionFailed {
            path: model_path.display().to_string(),
            message: format!("llama backend init failed: {err}"),
        })?;

        let params = LlamaModelParams::default();
        let model = LlamaModel::load_from_file(&backend, model_path, &params).map_err(|err| {
            CoreError::ExtractionFailed {
                path: model_path.display().to_string(),
                message: format!("model load failed: {err}"),
            }
        })?;

        Ok(Self {
            backend,
            model,
            n_ctx: N_CTX,
        })
    }

    /// Tokenizes a prompt with this model's tokenizer.
    fn tokenize(&self, prompt: &str) -> Result<Vec<LlamaToken>> {
        self.model
            .str_to_token(prompt, AddBos::Always)
            .map_err(|err| CoreError::ExtractionFailed {
                path: "tokenizer".into(),
                message: format!("tokenization failed: {err}"),
            })
    }

    /// Cuts an over-budget prompt down to the real token budget instead of
    /// failing: measures the fixed template overhead with an empty document,
    /// keeps a proportional share of the DOCUMENT text (never the system
    /// prompt or ChatML framing), and re-tokenizes to verify the fit. The
    /// truncation is marked so the model knows the document is incomplete.
    /// Fails only when even the truncated prompt cannot fit (defense in
    /// depth — unreachable with sane budgets).
    fn truncate_to_context(
        &self,
        source_hash: &str,
        raw_text: &str,
        tokens: &[LlamaToken],
    ) -> Result<Vec<LlamaToken>> {
        let overhead = self.tokenize(&build_chatml_prompt(source_hash, ""))?.len() as u64;
        let usable = (self.n_ctx as u64).saturating_sub(MAX_NEW_TOKENS as u64);
        let budget = usable.saturating_sub(overhead);

        // Scale from what the measured prompt actually contained, never from
        // the full document — see visible_doc_chars.
        let mut keep = visible_doc_chars(raw_text);
        let mut doc_tokens = (tokens.len() as u64).saturating_sub(overhead);
        let mut measured = tokens.len() as u64;

        for _ in 0..MAX_FIT_ATTEMPTS {
            keep = next_keep(keep, doc_tokens, budget);
            if keep == 0 {
                break;
            }
            let truncated: String = raw_text.chars().take(keep).collect();
            let prompt =
                build_chatml_prompt(source_hash, &format!("{truncated}\n[Dokument gekürzt]"));
            let candidate = self.tokenize(&prompt)?;
            measured = candidate.len() as u64;
            if measured < usable {
                return Ok(candidate);
            }
            doc_tokens = measured.saturating_sub(overhead);
        }

        Err(CoreError::ExtractionFailed {
            path: "prompt".into(),
            // Name the usable window, not n_ctx: the old message read
            // "6420 tokens does not fit in 8192", an arithmetic contradiction
            // on its face that sent debugging in the wrong direction.
            message: format!(
                "prompt ({measured} tokens) still exceeds the usable window ({usable} = context {} minus {MAX_NEW_TOKENS} reserved for output) after {MAX_FIT_ATTEMPTS} truncation attempts",
                self.n_ctx
            ),
        })
    }

    /// Runs one grammar-constrained extraction. Returns the model's raw JSON
    /// output (public for diagnostics/eval) plus whether generation stopped
    /// on the token budget rather than EOS — callers must treat a truncated
    /// `text` as failure, not parse it: greedy decoding is deterministic, so
    /// parsing half-JSON would fail identically on every retry.
    pub fn complete(&self, source_hash: &str, raw_text: &str) -> Result<Completion> {
        let mut ctx = self.new_context()?;
        self.complete_in(&mut ctx, source_hash, raw_text)
    }

    /// Builds a fresh inference context.
    ///
    /// Each one allocates the whole KV cache up front (measured: 1152 MiB at
    /// n_ctx 8192 on a 36-layer model, plus ~312 MiB of compute buffers), so
    /// this is the expensive part of a short extraction — `extract` builds
    /// ONE and reuses it across the document's windows rather than paying it
    /// per window.
    fn new_context(&self) -> Result<llama_cpp_2::context::LlamaContext<'_>> {
        let ctx_params = LlamaContextParams::default()
            .with_n_ctx(std::num::NonZeroU32::new(self.n_ctx))
            .with_n_batch(N_BATCH);
        self.model
            .new_context(&self.backend, ctx_params)
            .map_err(|err| CoreError::ExtractionFailed {
                path: "context".into(),
                message: format!("context creation failed: {err}"),
            })
    }

    /// One grammar-constrained generation on a caller-owned context.
    ///
    /// The context must be free of earlier state — `extract` clears the KV
    /// cache between windows. Reusing a dirty context would decode the new
    /// prompt on top of the previous window's positions.
    fn complete_in(
        &self,
        ctx: &mut llama_cpp_2::context::LlamaContext<'_>,
        source_hash: &str,
        raw_text: &str,
    ) -> Result<Completion> {
        let prompt = build_chatml_prompt(source_hash, raw_text);
        let tokens = self.tokenize(&prompt)?;
        let tokens = if tokens.len() as u64 + MAX_NEW_TOKENS as u64 >= self.n_ctx as u64 {
            self.truncate_to_context(source_hash, raw_text, &tokens)?
        } else {
            tokens
        };

        let mut batch = LlamaBatch::new(N_BATCH as usize, 1);
        // Chunked prefill: the prompt (up to n_ctx tokens after the
        // truncate_to_context fit) generally exceeds one N_BATCH window —
        // decode it in slices with global positions instead of one oversized
        // batch.add loop (which fails with "Insufficient Space").
        let total = tokens.len();
        for (chunk_idx, chunk) in tokens.chunks(N_BATCH as usize).enumerate() {
            batch.clear();
            let base = chunk_idx * N_BATCH as usize;
            for (j, token) in chunk.iter().enumerate() {
                let pos = base + j;
                let last = pos + 1 == total;
                batch
                    .add(
                        *token,
                        i32::try_from(pos).expect("prompt token count fits i32"),
                        &[0],
                        last,
                    )
                    .map_err(|err| CoreError::ExtractionFailed {
                        path: "batch".into(),
                        message: format!("batch add failed: {err}"),
                    })?;
            }
            ctx.decode(&mut batch)
                .map_err(|err| CoreError::ExtractionFailed {
                    path: "decode".into(),
                    message: format!("prompt decode failed: {err}"),
                })?;
        }

        // Grammar-constrained sampler chain: LLGuidance(JSON Schema) + greedy.
        let grammar =
            llguidance::api::TopLevelGrammar::from_tagged_str("json", EXTRACTION_JSON_SCHEMA)
                .map_err(|err| CoreError::ExtractionFailed {
                    path: "grammar".into(),
                    message: format!("invalid grammar: {err}"),
                })?;
        let tok_env = LlamaSampler::llguidance_tok_env(&self.model);
        let factory = llguidance::ParserFactory::new_simple(&tok_env).map_err(|err| {
            CoreError::ExtractionFailed {
                path: "grammar".into(),
                message: format!("parser factory failed: {err}"),
            }
        })?;
        let parser = factory
            .create_parser(grammar)
            .map_err(|err| CoreError::ExtractionFailed {
                path: "grammar".into(),
                message: format!("parser creation failed: {err}"),
            })?;
        let matcher = llguidance::Matcher::new(Ok(parser));
        let grammar_sampler = LlamaSampler::from(matcher);
        let mut sampler = LlamaSampler::chain_simple([grammar_sampler, LlamaSampler::greedy()]);

        let mut output = String::new();
        let mut decoder = encoding_rs::UTF_8.new_decoder();
        let mut n_cur = i32::try_from(total).expect("prompt token count fits i32");
        let mut generated: u32 = 0;
        // Greedy decoding is deterministic: hitting the token budget mid-JSON
        // would otherwise retry byte-identically forever (see
        // `Extractor::extract` — parse fails, doc stays pending, user
        // retries). Surface budget exhaustion as its own error path so the
        // caller can park the document with a reason instead.
        let mut truncated = false;

        loop {
            if generated >= MAX_NEW_TOKENS || n_cur as u32 >= self.n_ctx {
                truncated = true;
                break;
            }

            // LlamaSampler::sample() samples AND accepts the token in one
            // step — do NOT call sampler.accept(token) again afterwards;
            // a second accept would double-advance the grammar state and
            // silently desync constrained decoding from the emitted text.
            let token = sampler.sample(&ctx, batch.n_tokens() - 1);
            if token == self.model.token_eos() {
                break;
            }

            match self.model.token_to_piece(token, &mut decoder, true, None) {
                Ok(piece) => output.push_str(&piece),
                Err(err) => {
                    return Err(CoreError::ExtractionFailed {
                        path: "detokenize".into(),
                        message: format!("token_to_piece failed: {err}"),
                    });
                }
            }

            batch.clear();
            batch
                .add(token, n_cur, &[0], true)
                .map_err(|err| CoreError::ExtractionFailed {
                    path: "batch".into(),
                    message: format!("batch add failed: {err}"),
                })?;
            n_cur += 1;
            generated += 1;
            ctx.decode(&mut batch)
                .map_err(|err| CoreError::ExtractionFailed {
                    path: "decode".into(),
                    message: format!("generation decode failed: {err}"),
                })?;
        }

        if truncated {
            return Ok(Completion {
                text: output,
                truncated: true,
            });
        }

        Ok(Completion {
            text: output,
            truncated: false,
        })
    }
}

/// Raw output of one grammar-constrained generation pass.
pub struct Completion {
    /// The model's emitted text (complete JSON only when `truncated` is false).
    pub text: String,
    /// True when generation stopped on the token/context budget, not EOS.
    pub truncated: bool,
}

impl LlamaExtractor {
    /// One model pass over one window. The window is already sized to fit,
    /// so `complete`'s own truncation path should not trigger — if it does,
    /// the fit estimate was wrong and that is a failure, not a fragment to
    /// parse: greedy decoding is deterministic, so half-JSON fails
    /// identically on every retry.
    fn extract_window(
        &self,
        ctx: &mut llama_cpp_2::context::LlamaContext<'_>,
        source_hash: &str,
        window: &str,
    ) -> Result<Extraction> {
        let completion = self.complete_in(ctx, source_hash, window)?;
        if completion.truncated {
            return Err(CoreError::ExtractionFailed {
                path: "truncated".into(),
                message: format!(
                    "output hit the {MAX_NEW_TOKENS}-token budget mid-JSON — document too long for one extraction pass"
                ),
            });
        }
        let extraction = parse_extraction(&completion.text)?;

        // The grammar guarantees the hex SHAPE; the value must still be the
        // input document's hash, not a hallucinated one.
        if extraction.source_hash != source_hash {
            return Err(CoreError::ExtractionFailed {
                path: "grammar".into(),
                message: "model returned a source_hash that does not match the document".into(),
            });
        }
        Ok(extraction)
    }
}

impl Extractor for LlamaExtractor {
    fn extract(&self, source_hash: &str, raw_text: &str) -> Result<ExtractionOutcome> {
        let (windows, planned_coverage) = split_windows(raw_text);
        let mut merged: Option<Extraction> = None;
        let mut covered = 0usize;
        let mut window_error: Option<String> = None;

        // ONE context for the whole document. Each context allocates the full
        // KV cache up front (1152 MiB at n_ctx 8192, measured, plus ~312 MiB
        // of compute buffers), and the previous shape built a fresh one per
        // window — so a four-window document paid that allocation four times.
        // The KV cache is cleared between windows instead; windows are
        // independent prompts, not a conversation.
        let mut ctx = self.new_context()?;

        for (index, window) in windows.iter().enumerate() {
            if index > 0 {
                ctx.clear_kv_cache();
            }
            match self.extract_window(&mut ctx, source_hash, window) {
                Ok(extraction) => {
                    covered = if index + 1 == windows.len() {
                        planned_coverage
                    } else {
                        (index + 1) * MAX_PROMPT_DOC_CHARS
                            - index * WINDOW_OVERLAP_CHARS
                    };
                    match merged.as_mut() {
                        None => merged = Some(extraction),
                        Some(base) => crate::llm::merge_extraction(base, extraction),
                    }
                }
                // The first window failing is the document failing — there is
                // nothing to show. A later one failing keeps what the earlier
                // passes produced and stops: coverage reports what actually
                // reached the model, so the partial result cannot pass as
                // complete. Continuing past a gap would claim coverage the
                // model never had.
                Err(err) => {
                    if merged.is_none() {
                        return Err(err);
                    }
                    // Carried out to the caller instead of written to stderr:
                    // this is a library, the Tauri layer owns how things are
                    // logged, and `covered_chars` alone says coverage fell
                    // short without saying why.
                    window_error = Some(format!(
                        "extraction window {}/{} failed, kept {covered} chars of coverage: {err}",
                        index + 1,
                        windows.len()
                    ));
                    break;
                }
            }
        }

        let mut extraction = merged.ok_or_else(|| CoreError::ExtractionFailed {
            path: "windows".into(),
            message: "document produced no extraction windows".into(),
        })?;

        // Merging N windows can push a collection past the server's ingest
        // caps, and an over-cap payload is a 400 the outbox treats as
        // permanent. Clamp AFTER the backstop so its facts are the ones that
        // survive: they are precisely the details the model is known to miss.
        let model_fact_count = extraction.facts.len();
        // Deterministic backstop: label-anchored scans add the reference
        // numbers / contact channels the model dropped (never duplicates).
        // It reads the FULL text, not just the covered windows.
        crate::llm::ensure_key_details(raw_text, &mut extraction);
        crate::llm::clamp_to_ingest_limits(&mut extraction, model_fact_count);

        Ok(ExtractionOutcome {
            extraction,
            covered_chars: covered,
            window_error,
        })
    }
}
