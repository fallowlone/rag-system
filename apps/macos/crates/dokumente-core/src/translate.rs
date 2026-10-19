//! On-device translation with Helsinki OPUS-MT pairs exported to ONNX
//! (encoder fp32 + int8 decoder, greedy decode, no KV-cache — inputs are
//! short task/doc strings). Four pairs cover de/en/ru with an EN pivot for
//! de<->ru. No text ever leaves the device.
//!
//! Model files are fetched lazily per pair from the pinned HF revision (see
//! `TRANSLATE_*` consts) through `ModelManager::download_files`, which
//! verifies every sha256. The onnxruntime dylib travels the same channel.

use crate::error::{CoreError, Result};
use crate::llm::model_manager::FileSpec;
use ndarray::{Array2, Dimension};
use ort::{inputs, session::Session, value::Tensor};
use std::path::{Path, PathBuf};

/// Pinned HF revision of `fallowlone/papierkram-translate` — bump together
/// with the baked file hashes when re-exporting.
pub const TRANSLATE_REPO_REV: &str = "a1e241aef65708a70f20ccc62c43d6b525407810";
pub const TRANSLATE_BASE_URL: &str =
    "https://huggingface.co/fallowlone/papierkram-translate/resolve";

/// UI-facing input cap: bounds worst-case CPU time per call.
pub const MAX_TRANSLATE_CHARS: usize = 2000;
/// Hard stop for the greedy loop (short strings finish in a dozen steps).
const MAX_NEW_TOKENS: usize = 160;
/// Marian encoder context — inputs longer than this are truncated by pieces.
const MAX_INPUT_PIECES: usize = 256;

/// Upper bound for a `vocab.json`-derived vocabulary. Real OPUS-MT
/// SentencePiece vocabs are tens of thousands of entries; anything beyond
/// this from an untrusted file is treated as corruption instead of
/// attempting a multi-billion-element allocation.
const MAX_VOCAB_SIZE: usize = 512_000;

/// onnxruntime dylib, downloaded once next to the model pairs.
pub const ORT_DYLIB: FileSpec = FileSpec {
    name: "onnxruntime/libonnxruntime.dylib",
    sha256: "8ab8982e8fc0a3d5121bf95404dba7a15d70b7df49a8bab1ba481ff961d93dc8",
    size_bytes: 33332888,
};

/// The four ONNX pairs (encoder fp32 + int8 decoder + SentencePiece files).
/// Hashes are baked at export time — see the export log, never TOFU.
pub const TRANSLATE_PAIRS: &[(&str, &[FileSpec])] = &[
    (
        "de-en",
        &[
            FileSpec {
                name: "de-en/encoder_model.onnx",
                sha256: "e856b705d0923d4b1261679eb956d1c2c1ff8935aca6ba4f6f7d6080970f8f3a",
                size_bytes: 195770998,
            },
            FileSpec {
                name: "de-en/decoder_model.onnx",
                sha256: "6a6366d4669da50416b10d893a9fe8752a80cf8911f870de29af32968e3aa74d",
                size_bytes: 85747954,
            },
            FileSpec {
                name: "de-en/source.spm",
                sha256: "bbd1f495eea99c8e21ae086d9146e0fa7b096c3dfdd9ba07ab8b631889df5c9b",
                size_bytes: 796845,
            },
            FileSpec {
                name: "de-en/target.spm",
                sha256: "678f2a1177d8389f67b66299762dcc4fc567e89b07e212ba91b0c56daecf47ce",
                size_bytes: 768489,
            },
            FileSpec {
                name: "de-en/vocab.json",
                sha256: "d5acea957b265a78554999144459c5e391e0df525864edc8287bc090290baa44",
                size_bytes: 1389436,
            },
            FileSpec {
                name: "de-en/manifest.json",
                sha256: "c7fb2d71e27c3f1a68c6fae098a78ec6a1aff2e85fa602ee92e0a8b01d983f8b",
                size_bytes: 713,
            },
        ],
    ),
    (
        "en-de",
        &[
            FileSpec {
                name: "en-de/encoder_model.onnx",
                sha256: "37ab9f4b502e5ce585459a509155fc23aab071962bdf83bc2bef20e926489cc2",
                size_bytes: 195770998,
            },
            FileSpec {
                name: "en-de/decoder_model.onnx",
                sha256: "0e352abc30015da367bb2b07666f9b60e4535953dbc5cb38a59e2cbeb2264e20",
                size_bytes: 85747953,
            },
            FileSpec {
                name: "en-de/source.spm",
                sha256: "678f2a1177d8389f67b66299762dcc4fc567e89b07e212ba91b0c56daecf47ce",
                size_bytes: 768489,
            },
            FileSpec {
                name: "en-de/target.spm",
                sha256: "bbd1f495eea99c8e21ae086d9146e0fa7b096c3dfdd9ba07ab8b631889df5c9b",
                size_bytes: 796845,
            },
            FileSpec {
                name: "en-de/vocab.json",
                sha256: "d5acea957b265a78554999144459c5e391e0df525864edc8287bc090290baa44",
                size_bytes: 1389436,
            },
            FileSpec {
                name: "en-de/manifest.json",
                sha256: "a9f09aa3f9fde0f3546030bb186e53cb999257e63b5dc30b6301a2669d09a584",
                size_bytes: 713,
            },
        ],
    ),
    (
        "ru-en",
        &[
            FileSpec {
                name: "ru-en/encoder_model.onnx",
                sha256: "c983008c4bbb0cd51d730f3374d8a9b59b5b7fce733075adb277f1eefa5abb1f",
                size_bytes: 204817014,
            },
            FileSpec {
                name: "ru-en/decoder_model.onnx",
                sha256: "0e2718da590e3398917b4ce3656cd8fa1f65ff51c5d53d86d2c60fb12b1349fb",
                size_bytes: 90288630,
            },
            FileSpec {
                name: "ru-en/source.spm",
                sha256: "745998e51ba5b058e38b7ac7765c25c43ed5c1c39cc92b27163b9b2e323c9d7c",
                size_bytes: 1080169,
            },
            FileSpec {
                name: "ru-en/target.spm",
                sha256: "16bebef1389a0b8ab452772c4e35b9e605e5713f8ac7baa71ca701394eaa086d",
                size_bytes: 802781,
            },
            FileSpec {
                name: "ru-en/vocab.json",
                sha256: "5cf0d95d930d8d3e783c9e2f46a72f08b43a18060dab4ddefbcb66a733efedcb",
                size_bytes: 2726796,
            },
            FileSpec {
                name: "ru-en/manifest.json",
                sha256: "e3942d84bbdd1d690d9618409252956a4a5130757ee24e80e23cf34ac6b985cd",
                size_bytes: 714,
            },
        ],
    ),
    (
        "en-ru",
        &[
            FileSpec {
                name: "en-ru/encoder_model.onnx",
                sha256: "53ab98ba94f1254ae1736f96e15813ac10f87a68e327955dfb53c409c76a9dde",
                size_bytes: 204817014,
            },
            FileSpec {
                name: "en-ru/decoder_model.onnx",
                sha256: "8bfdd515d15710fadc17b837728b69227d6240734a2605e6c3be0b5d629be0a9",
                size_bytes: 90288630,
            },
            FileSpec {
                name: "en-ru/source.spm",
                sha256: "16bebef1389a0b8ab452772c4e35b9e605e5713f8ac7baa71ca701394eaa086d",
                size_bytes: 802781,
            },
            FileSpec {
                name: "en-ru/target.spm",
                sha256: "745998e51ba5b058e38b7ac7765c25c43ed5c1c39cc92b27163b9b2e323c9d7c",
                size_bytes: 1080169,
            },
            FileSpec {
                name: "en-ru/vocab.json",
                sha256: "5cf0d95d930d8d3e783c9e2f46a72f08b43a18060dab4ddefbcb66a733efedcb",
                size_bytes: 2726796,
            },
            FileSpec {
                name: "en-ru/manifest.json",
                sha256: "c5d5313f8aa3722ecba64603d158eac7d91c52bde41604bf52b3bf1eedf4cd55",
                size_bytes: 714,
            },
        ],
    ),
];

/// File layout under the translate root: `<root>/<pair>/…`, dylib at
/// `<root>/onnxruntime/libonnxruntime.dylib`.
pub fn pair_dir(root: &Path, pair: &str) -> PathBuf {
    root.join(pair)
}

pub fn ort_dylib_path(root: &Path) -> PathBuf {
    root.join(ORT_DYLIB.name)
}

/// Looks up a pair's file list, or None for an unknown pair name.
pub fn pair_files(pair: &str) -> Option<&'static [FileSpec]> {
    TRANSLATE_PAIRS
        .iter()
        .find(|(name, _)| *name == pair)
        .map(|(_, files)| *files)
}

/// True when every file of the pair is present with a plausible size.
/// Hashes are verified at download time, not on every call.
pub fn pair_downloaded(root: &Path, pair: &str) -> bool {
    let Some(files) = pair_files(pair) else {
        return false;
    };
    files
        .iter()
        .all(|f| crate::llm::model_manager::file_present(&root.join(f.name), f.size_bytes))
}

/// Routes a language pair to the ONNX pair chain: direct when available,
/// EN pivot for de<->ru, empty (no-op) for same language.
pub fn route_pair(from: &str, to: &str) -> Result<Vec<String>> {
    let (from, to) = (from.to_lowercase(), to.to_lowercase());
    for lang in [&from, &to] {
        if !matches!(lang.as_str(), "de" | "en" | "ru") {
            return Err(CoreError::Translate(format!(
                "unsupported language: {lang} (supported: de, en, ru)"
            )));
        }
    }
    if from == to {
        return Ok(vec![]);
    }
    let direct = format!("{from}-{to}");
    if TRANSLATE_PAIRS.iter().any(|(name, _)| *name == direct) {
        return Ok(vec![direct]);
    }
    Ok(vec![format!("{from}-en"), format!("en-{to}")])
}

#[derive(Debug, serde::Deserialize)]
struct PairManifest {
    #[allow(dead_code)]
    pair: String,
    pad_id: i64,
    eos_id: i64,
    unk_id: i64,
}

/// One loaded ONNX pair: encoder + decoder sessions, SentencePiece
/// segmenters and the shared piece<->id vocabulary (OPUS-MT embeddings
/// follow vocab.json order, NOT the .spm internal ids — ids must be
/// mediated through it on both sides, exactly like MarianTokenizer).
/// Send + Sync so it can live in shared app state.
pub struct Translator {
    enc: Session,
    dec: Session,
    sp_src: sentencepiece::SentencePieceProcessor,
    sp_tgt: sentencepiece::SentencePieceProcessor,
    src_vocab: std::collections::HashMap<String, u32>,
    tgt_pieces: Vec<String>,
    pad_id: i64,
    eos_id: i64,
    unk_id: i64,
}

// ort::Session and SentencePieceProcessor are both Send + Sync; assert it
// here so a dependency upgrade breaks loudly instead of silently.
fn _assert_send_sync<T: Send + Sync>() {}
fn _assert_translator() {
    _assert_send_sync::<Translator>();
}

impl Translator {
    /// Loads a pair from `<root>/<pair>/` (manifest + 6 files).
    /// Call `ensure_ort` with the downloaded dylib first.
    pub fn load(root: &Path, pair: &str) -> Result<Self> {
        // Allowlist first: `pair` becomes a path segment below, and this
        // function is `pub` — a future caller passing `"../../x"` must not
        // turn it into directory traversal outside the translate root.
        if pair_files(pair).is_none() {
            return Err(CoreError::Translate(format!("unknown pair: {pair}")));
        }
        let dir = pair_dir(root, pair);
        let manifest_raw = std::fs::read_to_string(dir.join("manifest.json"))
            .map_err(|e| CoreError::Translate(format!("missing manifest for pair {pair}: {e}")))?;
        let manifest: PairManifest = serde_json::from_str(&manifest_raw)
            .map_err(|e| CoreError::Translate(format!("bad manifest for pair {pair}: {e}")))?;
        // Ids flow into `as u32`/`as usize` casts and stop conditions below —
        // reject negatives here instead of wrapping them into huge values.
        for (name, id) in [
            ("pad_id", manifest.pad_id),
            ("eos_id", manifest.eos_id),
            ("unk_id", manifest.unk_id),
        ] {
            if id < 0 {
                return Err(CoreError::Translate(format!(
                    "bad manifest for pair {pair}: negative {name}"
                )));
            }
        }
        let enc = Session::builder()
            .and_then(|mut b| b.commit_from_file(dir.join("encoder_model.onnx")))
            .map_err(|e| CoreError::Translate(format!("encoder load failed: {e}")))?;
        let dec = Session::builder()
            .and_then(|mut b| b.commit_from_file(dir.join("decoder_model.onnx")))
            .map_err(|e| CoreError::Translate(format!("decoder load failed: {e}")))?;
        let sp_src = sentencepiece::SentencePieceProcessor::open(dir.join("source.spm"))
            .map_err(|e| CoreError::Translate(format!("source spm load failed: {e}")))?;
        let sp_tgt = sentencepiece::SentencePieceProcessor::open(dir.join("target.spm"))
            .map_err(|e| CoreError::Translate(format!("target spm load failed: {e}")))?;
        let vocab_raw = std::fs::read_to_string(dir.join("vocab.json"))
            .map_err(|e| CoreError::Translate(format!("missing vocab for pair {pair}: {e}")))?;
        let src_vocab: std::collections::HashMap<String, u32> = serde_json::from_str(&vocab_raw)
            .map_err(|e| CoreError::Translate(format!("bad vocab for pair {pair}: {e}")))?;
        let vocab_size = src_vocab.values().copied().max().unwrap_or(0) as usize + 1;
        if vocab_size > MAX_VOCAB_SIZE {
            return Err(CoreError::Translate(format!(
                "bad vocab for pair {pair}: implausible size {vocab_size}"
            )));
        }
        let mut tgt_pieces = vec![String::new(); vocab_size];
        for (piece, id) in &src_vocab {
            if (*id as usize) < vocab_size {
                tgt_pieces[*id as usize] = piece.clone();
            }
        }
        Ok(Self {
            enc,
            dec,
            sp_src,
            sp_tgt,
            src_vocab,
            tgt_pieces,
            pad_id: manifest.pad_id,
            eos_id: manifest.eos_id,
            unk_id: manifest.unk_id,
        })
    }

    /// Translates one short string. Empty input returns empty output; an
    /// empty model output is an error (known Marian quirk on some short
    /// imperatives) so callers can fall back to the source text.
    pub fn translate(&mut self, text: &str) -> Result<String> {
        // Bound worst-case CPU here too, not just at the Tauri boundary —
        // direct core callers must not get unbounded encoder/decoder work.
        let text: String = text.chars().take(MAX_TRANSLATE_CHARS).collect();
        if text.trim().is_empty() {
            return Ok(String::new());
        }
        // Segment with SentencePiece, then map pieces through vocab.json —
        // the .spm internal ids do NOT match the model's embedding rows.
        let unk = self.unk_id as u32;
        let mut ids: Vec<i64> = self
            .sp_src
            .encode(&text)
            .map_err(|e| CoreError::Translate(format!("encode failed: {e}")))?
            .into_iter()
            .map(|p| self.src_vocab.get(&p.piece).copied().unwrap_or(unk) as i64)
            .collect();
        ids.truncate(MAX_INPUT_PIECES);
        if ids.is_empty() {
            return Err(CoreError::Translate("encode produced no pieces".into()));
        }
        // Marian convention (matching the HF tokenizer): source ends with EOS.
        if ids.last() != Some(&self.eos_id) {
            ids.push(self.eos_id);
        }
        let n = ids.len();
        let input_ids = Tensor::from_array(
            Array2::from_shape_vec((1, n), ids)
                .map_err(|e| CoreError::Translate(format!("input shape: {e}")))?,
        )
        .map_err(|e| CoreError::Translate(format!("input tensor: {e}")))?;
        let mask = Tensor::from_array(Array2::from_elem((1, n), 1i64))
            .map_err(|e| CoreError::Translate(format!("mask tensor: {e}")))?;
        let enc_out = self
            .enc
            .run(inputs!["input_ids" => input_ids, "attention_mask" => mask])
            .map_err(|e| CoreError::Translate(format!("encoder failed: {e}")))?;
        let (enc_shape, enc_data) = enc_out["last_hidden_state"]
            .try_extract_tensor::<f32>()
            .map_err(|e| CoreError::Translate(format!("encoder output: {e}")))?;
        let dims = enc_shape.to_ixdyn();
        // Rank-3 [1, seq, hidden]; anything else is a mismatched export —
        // fail loudly instead of panicking on dims[2]/dims[1] below.
        if dims.ndim() != 3 {
            return Err(CoreError::Translate(format!(
                "encoder rank mismatch: expected 3, got {}",
                dims.ndim()
            )));
        }
        let hidden = dims[2];
        let seq = dims[1];
        if enc_data.len() != seq * hidden {
            return Err(CoreError::Translate("encoder shape mismatch".into()));
        }

        // Loop-invariant: the encoder states never change during decoding.
        let hs = Tensor::from_array(
            Array2::from_shape_vec((seq, hidden), enc_data.to_vec())
                .map_err(|e| CoreError::Translate(format!("hidden reshape: {e}")))?
                .into_shape_with_order((1, seq, hidden))
                .map_err(|e| CoreError::Translate(format!("hidden reshape: {e}")))?,
        )
        .map_err(|e| CoreError::Translate(format!("hidden tensor: {e}")))?;

        let mut out: Vec<i64> = vec![self.pad_id];
        for _ in 0..MAX_NEW_TOKENS {
            let m = out.len();
            let dec_in = Tensor::from_array(
                Array2::from_shape_vec((1, m), out.clone())
                    .map_err(|e| CoreError::Translate(format!("decoder shape: {e}")))?,
            )
            .map_err(|e| CoreError::Translate(format!("decoder tensor: {e}")))?;
            let dec_mask = Tensor::from_array(Array2::from_elem((1, n), 1i64))
                .map_err(|e| CoreError::Translate(format!("decoder mask: {e}")))?;
            let dec_out = self
                .dec
                .run(inputs![
                    "input_ids" => dec_in,
                    "encoder_attention_mask" => dec_mask,
                    "encoder_hidden_states" => hs.clone()
                ])
                .map_err(|e| CoreError::Translate(format!("decoder failed: {e}")))?;
            let (_, logits) = dec_out["logits"]
                .try_extract_tensor::<f32>()
                .map_err(|e| CoreError::Translate(format!("decoder output: {e}")))?;
            // Flat row-major [m, vocab]: validate the shape instead of
            // silently scoring the wrong row on a surprising output.
            let vocab = self.tgt_pieces.len();
            if logits.len() != m * vocab {
                return Err(CoreError::Translate(format!(
                    "logits shape mismatch: got {} values for {m} steps",
                    logits.len()
                )));
            }
            let last = &logits[(m - 1) * vocab..m * vocab];
            let best = last
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
                .map(|(i, _)| i as i64)
                .unwrap_or(self.eos_id);
            out.push(best);
            if best == self.eos_id {
                break;
            }
        }
        out.retain(|&id| id != self.pad_id && id != self.eos_id);
        if out.is_empty() {
            return Err(CoreError::Translate("model returned empty output".into()));
        }
        // Ids back through the shared vocab, then SentencePiece detokenize.
        let pieces: Vec<&str> = out
            .into_iter()
            .map(|id| {
                self.tgt_pieces
                    .get(id as usize)
                    .map(String::as_str)
                    .unwrap_or("")
            })
            .collect();
        self.sp_tgt
            .decode_pieces(&pieces)
            .map_err(|e| CoreError::Translate(format!("decode failed: {e}")))
    }
}

/// Points ort at the downloaded dylib. Idempotent: repeat calls after the
/// first success are no-ops. The check-then-act is serialized by a mutex
/// (double-checked) — concurrent first-run callers elect one initializer
/// instead of racing two `commit()`s against ort's version-fragile
/// double-init contract.
pub fn ensure_ort(dylib: &Path) -> Result<()> {
    use std::sync::atomic::{AtomicBool, Ordering};
    static READY: AtomicBool = AtomicBool::new(false);
    static INIT_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    if READY.load(Ordering::SeqCst) {
        return Ok(());
    }
    let _guard = INIT_LOCK
        .lock()
        .map_err(|_| CoreError::Translate("ort init lock poisoned".into()))?;
    if READY.load(Ordering::SeqCst) {
        return Ok(());
    }
    ort::init_from(dylib)
        .map_err(|e| CoreError::Translate(format!("onnxruntime load failed: {e}")))?
        .commit();
    READY.store(true, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn load_rejects_unknown_pair_without_touching_fs() {
        // Allowlist gate runs before any path join: traversal input can
        // never become a directory read, even from a future caller.
        assert!(matches!(
            Translator::load(std::path::Path::new("/tmp"), "../../x"),
            Err(CoreError::Translate(_))
        ));
        let Err(CoreError::Translate(msg)) =
            Translator::load(std::path::Path::new("/tmp"), "de-en")
        else {
            panic!("expected a missing-manifest error");
        };
        assert!(msg.contains("missing manifest"), "unexpected: {msg}");
    }

    #[test]
    fn route_direct_pairs() {
        assert_eq!(route_pair("de", "en").unwrap(), vec!["de-en".to_string()]);
        assert_eq!(route_pair("en", "de").unwrap(), vec!["en-de".to_string()]);
        assert_eq!(route_pair("ru", "en").unwrap(), vec!["ru-en".to_string()]);
        assert_eq!(route_pair("en", "ru").unwrap(), vec!["en-ru".to_string()]);
    }

    #[test]
    fn route_pivots_through_english() {
        assert_eq!(
            route_pair("de", "ru").unwrap(),
            vec!["de-en".to_string(), "en-ru".to_string()]
        );
        assert_eq!(
            route_pair("ru", "de").unwrap(),
            vec!["ru-en".to_string(), "en-de".to_string()]
        );
    }

    #[test]
    fn route_same_language_is_noop() {
        assert!(route_pair("de", "de").unwrap().is_empty());
        assert!(route_pair("RU", "ru").unwrap().is_empty());
    }

    #[test]
    fn route_rejects_unknown_languages() {
        assert!(route_pair("de", "fr").is_err());
        assert!(route_pair("xx", "de").is_err());
    }

    #[test]
    fn route_is_case_insensitive() {
        assert_eq!(route_pair("DE", "EN").unwrap(), vec!["de-en".to_string()]);
    }

    #[test]
    fn pair_registry_is_complete() {
        for pair in ["de-en", "en-de", "ru-en", "en-ru"] {
            let files = pair_files(pair).expect("pair registered");
            assert_eq!(files.len(), 6);
            let names: Vec<_> = files.iter().map(|f| f.name).collect();
            assert!(
                names.iter().any(|n| n.ends_with("encoder_model.onnx")),
                "{pair}"
            );
            assert!(
                names.iter().any(|n| n.ends_with("decoder_model.onnx")),
                "{pair}"
            );
            assert!(names.iter().any(|n| n.ends_with("source.spm")), "{pair}");
            assert!(names.iter().any(|n| n.ends_with("target.spm")), "{pair}");
            assert!(names.iter().any(|n| n.ends_with("vocab.json")), "{pair}");
            assert!(names.iter().any(|n| n.ends_with("manifest.json")), "{pair}");
        }
        assert!(pair_files("fr-de").is_none());
    }

    #[test]
    fn pair_not_downloaded_for_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!pair_downloaded(dir.path(), "de-en"));
        assert!(!pair_downloaded(dir.path(), "xx-yy"));
    }

    /// Full engine test against real exported files. Needs the export tree:
    /// TRANSLATE_TEST_DIR=/tmp/onnx-export TRANSLATE_DYLIB=/tmp/…/libonnxruntime.dylib.
    /// Skipped (not failed) anywhere else — 280MB fixtures can't ship in git.
    #[test]
    fn translator_matches_python_reference() {
        let (root, dylib) = match (
            std::env::var("TRANSLATE_TEST_DIR"),
            std::env::var("TRANSLATE_DYLIB"),
        ) {
            (Ok(r), Ok(d)) => (r, d),
            _ => {
                eprintln!("skipped: set TRANSLATE_TEST_DIR + TRANSLATE_DYLIB to run");
                return;
            }
        };
        ensure_ort(Path::new(&dylib)).unwrap();
        let mut t = Translator::load(Path::new(&root), "de-en").unwrap();
        let out = t
            .translate(
                "Gegen diesen Bescheid können Sie innerhalb eines Monats Widerspruch einlegen.",
            )
            .unwrap();
        assert!(
            out.contains("object") && out.contains("month"),
            "unexpected: {out}"
        );
        // Empty input is a clean no-op, empty model output is an error.
        assert_eq!(t.translate("   ").unwrap(), "");
    }
}

#[cfg(test)]
mod first_run_tests {
    use super::*;
    use crate::llm::model_manager::{HttpDownload, ModelManager};

    /// Full first-run path exactly as the app does it: download dylib + one
    /// pair from the real HF repo (pinned rev + sha256), init ort, load,
    /// translate. Needs network; ignored by default, run explicitly.
    #[test]
    #[ignore]
    fn first_run_download_init_translate() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("translate");
        let base = format!("{TRANSLATE_BASE_URL}/{TRANSLATE_REPO_REV}");
        let transport = HttpDownload;
        let manager = ModelManager::new(&transport, &root);
        let mut progress = |_, _| {};
        manager
            .download_files(&base, &root, &[ORT_DYLIB], &mut progress)
            .expect("dylib download");
        let pair = "de-en";
        manager
            .download_files(&base, &root, pair_files(pair).unwrap(), &mut progress)
            .expect("pair download");
        assert!(pair_downloaded(&root, pair));
        ensure_ort(&ort_dylib_path(&root)).expect("ort init");
        let mut t = Translator::load(&root, pair).expect("translator load");
        let out = t
            .translate(
                "Gegen diesen Bescheid können Sie innerhalb eines Monats Widerspruch einlegen.",
            )
            .expect("translate");
        assert!(out.contains("month"), "unexpected: {out}");
        println!("FIRST-RUN OK: {out}");
    }
}
