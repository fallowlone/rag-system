#[cfg(test)]
mod tests {
    use crate::llm::model_manager::*;
    use sha2::{Digest, Sha256};

    struct MemoryTransport {
        content: Vec<u8>,
        /// What the origin claims the file's sha256 is (HF `x-linked-etag`).
        upstream_sha256: Option<String>,
    }

    impl MemoryTransport {
        fn new(content: Vec<u8>) -> Self {
            Self {
                content,
                upstream_sha256: None,
            }
        }
    }

    impl DownloadTransport for MemoryTransport {
        fn open(&self, _url: &str) -> std::result::Result<DownloadStream, String> {
            Ok(DownloadStream {
                reader: Box::new(std::io::Cursor::new(self.content.clone())),
                total: Some(self.content.len() as u64),
                upstream_sha256: self.upstream_sha256.clone(),
            })
        }
    }

    fn spec_with_hash(content: &[u8]) -> ModelSpec {
        let hash = hex::encode(Sha256::digest(content));
        // Leak a &'static str in tests — the spec type demands it.
        let leaked: &'static str = Box::leak(hash.into_boxed_str());
        ModelSpec {
            name: "test-model",
            url: "https://example.com/model.gguf",
            sha256: Some(leaked),
            size_bytes: content.len() as u64,
        }
    }

    #[test]
    fn download_and_verify_stores_matching_file() {
        let content = b"model weights bytes".to_vec();
        let spec = spec_with_hash(&content);
        let dir = tempfile::tempdir().unwrap();
        let transport = MemoryTransport::new(content);

        let manager = ModelManager::new(&transport, dir.path());
        let outcome = manager.download_and_verify(&spec, &mut |_, _| {}).unwrap();
        assert!(matches!(outcome, DownloadOutcome::Verified(_)));

        let stored = manager.model_path(&spec);
        assert_eq!(std::fs::read(&stored).unwrap(), b"model weights bytes");
        // No temp file left behind
        assert!(!dir.path().join(".test-model.download").exists());
        assert!(manager.is_downloaded(&spec));
    }

    #[test]
    fn hash_mismatch_deletes_file_and_reports() {
        let hash = "deadbeef".repeat(8);
        let leaked: &'static str = Box::leak(hash.into_boxed_str());
        let spec = ModelSpec {
            name: "evil-model",
            url: "https://example.com/model.gguf",
            sha256: Some(leaked),
            size_bytes: 9,
        };
        let dir = tempfile::tempdir().unwrap();
        let transport = MemoryTransport::new(b"tampered!".to_vec());

        let manager = ModelManager::new(&transport, dir.path());
        let outcome = manager.download_and_verify(&spec, &mut |_, _| {}).unwrap();
        assert_eq!(outcome, DownloadOutcome::HashMismatch);
        assert!(!manager.model_path(&spec).exists());
        assert!(!dir.path().join(".evil-model.download").exists());
        assert!(!manager.is_downloaded(&spec));
    }

    #[test]
    fn unpinned_spec_returns_computed_hash_for_pinning() {
        let content = b"weights".to_vec();
        let spec = ModelSpec {
            name: "tofu-model",
            url: "https://example.com/model.gguf",
            sha256: None,
            size_bytes: content.len() as u64,
        };
        let dir = tempfile::tempdir().unwrap();
        let transport = MemoryTransport::new(content);

        let manager = ModelManager::new(&transport, dir.path());
        let outcome = manager.download_and_verify(&spec, &mut |_, _| {}).unwrap();
        match outcome {
            DownloadOutcome::Unpinned { sha256, .. } => {
                assert_eq!(sha256, hex::encode(Sha256::digest(b"weights")));
            }
            other => panic!("expected Unpinned, got {other:?}"),
        }
        assert!(manager.is_downloaded(&spec));
    }

    #[test]
    fn is_downloaded_false_when_missing() {
        let dir = tempfile::tempdir().unwrap();
        let transport = MemoryTransport::new(vec![]);
        let manager = ModelManager::new(&transport, dir.path());
        assert!(!manager.is_downloaded(&QWEN3_8B_Q4));
    }

    #[test]
    fn preexisting_valid_file_is_recognized_without_download() {
        let content = b"already here".to_vec();
        let spec = spec_with_hash(&content);
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("test-model.gguf"), &content).unwrap();

        let transport = MemoryTransport::new(b"different".to_vec());
        let manager = ModelManager::new(&transport, dir.path());
        assert!(manager.is_downloaded(&spec));
    }

    #[test]
    fn primary_model_hash_is_pinned() {
        // Trust anchor for the 8B download, verified 2026-09-05: the local
        // production file's sha256 matched the upstream `x-linked-etag`
        // header byte-for-byte. Must never regress to None (TOFU) or drift.
        assert_eq!(
            QWEN3_8B_Q4.sha256,
            Some("d98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785")
        );
    }

    #[test]
    fn official_model_specs_are_wellformed() {
        for spec in [&QWEN3_8B_Q4, &QWEN3_4B_Q4] {
            assert!(spec.url.starts_with("https://"));
            assert!(spec.url.ends_with(".gguf"));
            assert!(spec.size_bytes > 1_000_000_000);
            if let Some(hash) = spec.sha256 {
                assert_eq!(hash.len(), 64);
            }
        }
    }

    #[test]
    fn download_reports_progress_with_total() {
        let content = vec![7u8; 600_000]; // > one 256 KB chunk
        let spec = spec_with_hash(&content);
        let dir = tempfile::tempdir().unwrap();
        let transport = MemoryTransport::new(content);

        let manager = ModelManager::new(&transport, dir.path());
        let mut calls: Vec<(u64, Option<u64>)> = Vec::new();
        let outcome = manager
            .download_and_verify(&spec, &mut |downloaded, total| {
                calls.push((downloaded, total));
            })
            .unwrap();
        assert!(matches!(outcome, DownloadOutcome::Verified(_)));

        assert!(!calls.is_empty());
        assert_eq!(calls.last().unwrap().0, 600_000, "final report = full size");
        assert_eq!(calls.last().unwrap().1, Some(600_000));
        // Monotonically increasing
        for pair in calls.windows(2) {
            assert!(pair[1].0 > pair[0].0);
        }
    }

    #[test]
    fn stale_partial_download_from_interrupted_run_is_discarded() {
        // Simulate: app closed mid-download -> a partial .download file with
        // garbage stays behind. A retry must delete it and still produce a
        // verified file.
        let content = b"complete weights".to_vec();
        let spec = spec_with_hash(&content);
        let dir = tempfile::tempdir().unwrap();

        let stale_tmp = dir.path().join(".test-model.download");
        std::fs::write(&stale_tmp, b"PARTIAL GARBAGE FROM KILLED RUN").unwrap();

        let transport = MemoryTransport::new(content);
        let manager = ModelManager::new(&transport, dir.path());
        let outcome = manager.download_and_verify(&spec, &mut |_, _| {}).unwrap();

        assert!(matches!(outcome, DownloadOutcome::Verified(_)));
        assert_eq!(
            std::fs::read(manager.model_path(&spec)).unwrap(),
            b"complete weights"
        );
        assert!(!stale_tmp.exists());
    }

    fn file_spec(name: &'static str, content: &[u8]) -> FileSpec {
        let hash = hex::encode(Sha256::digest(content));
        let leaked: &'static str = Box::leak(hash.into_boxed_str());
        FileSpec {
            name,
            sha256: leaked,
            size_bytes: content.len() as u64,
        }
    }

    #[test]
    fn download_files_fetches_missing_and_skips_present() {
        let content = b"pair file bytes".to_vec();
        let dir = tempfile::tempdir().unwrap();
        // Pre-seed one file as already present with matching size.
        std::fs::create_dir_all(dir.path().join("de-en")).unwrap();
        std::fs::write(dir.path().join("de-en/encoder_model.onnx"), &content).unwrap();

        let transport = MemoryTransport::new(content.clone());
        let manager = ModelManager::new(&transport, dir.path());
        let files = [
            file_spec("de-en/encoder_model.onnx", &content),
            file_spec("de-en/decoder_model.onnx", &content),
        ];
        let fetched = manager
            .download_files("https://example.com/t", dir.path(), &files, &mut |_, _| {})
            .unwrap();
        // encoder was present (size matches) → only the decoder fetched.
        assert_eq!(fetched, 1);
        assert_eq!(
            std::fs::read(dir.path().join("de-en/decoder_model.onnx")).unwrap(),
            content
        );
    }

    #[test]
    fn download_files_rejects_hash_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        let transport = MemoryTransport::new(b"wrong bytes".to_vec());
        let manager = ModelManager::new(&transport, dir.path());
        let files = [file_spec("de-en/encoder_model.onnx", b"right bytes")];
        let err = manager
            .download_files("https://example.com/t", dir.path(), &files, &mut |_, _| {})
            .unwrap_err();
        assert!(matches!(err, crate::error::CoreError::Sync(_)));
        assert!(!dir.path().join("de-en/encoder_model.onnx").exists());
    }

    #[test]
    fn download_and_verify_refuses_when_disk_cannot_fit() {
        let content = b"model weights bytes".to_vec();
        let spec = ModelSpec {
            name: "huge-model",
            url: "https://example.com/model.gguf",
            sha256: None,
            size_bytes: u64::MAX,
        };
        let dir = tempfile::tempdir().unwrap();
        let transport = MemoryTransport::new(content);

        let manager = ModelManager::new(&transport, dir.path());
        let err = manager
            .download_and_verify(&spec, &mut |_, _| {})
            .unwrap_err();
        let message = err.to_string();
        assert!(
            message.contains("not enough disk space"),
            "unexpected error: {message}"
        );
        // Nothing was fetched or left behind.
        assert!(!dir.path().join("huge-model.gguf").exists());
    }

    #[test]
    fn free_space_reports_a_plausible_number_for_tmp() {
        let dir = tempfile::tempdir().unwrap();
        let free = free_space_bytes(dir.path()).expect("statvfs must work on tmp");
        assert!(free > 0, "free space must be positive");
    }

    #[test]
    fn total_memory_reports_a_plausible_number() {
        let total = total_memory_bytes().expect("RAM query must work here");
        assert!(total > 1024 * 1024 * 1024, "total RAM above 1 GiB");
    }
}

#[cfg(test)]
mod upstream_verification_tests {
    use crate::llm::model_manager::*;
    use sha2::{Digest, Sha256};

    struct Transport {
        content: Vec<u8>,
        upstream: Option<String>,
    }

    impl DownloadTransport for Transport {
        fn open(&self, _url: &str) -> std::result::Result<DownloadStream, String> {
            Ok(DownloadStream {
                reader: Box::new(std::io::Cursor::new(self.content.clone())),
                total: Some(self.content.len() as u64),
                upstream_sha256: self.upstream.clone(),
            })
        }
    }

    fn unpinned_spec(len: u64) -> ModelSpec {
        ModelSpec {
            name: "unpinned-model",
            url: "https://example.com/model.gguf",
            sha256: None,
            size_bytes: len,
        }
    }

    #[test]
    fn parse_sha256_etag_accepts_only_a_real_digest() {
        let digest = "a".repeat(64);
        assert_eq!(parse_sha256_etag(&format!("\"{digest}\"")), Some(digest.clone()));
        assert_eq!(parse_sha256_etag(&format!("W/\"{digest}\"")), Some(digest.clone()));
        assert_eq!(parse_sha256_etag(&digest.to_uppercase()), Some(digest));
        // An ordinary HTTP ETag is an opaque token, not a digest — treating
        // one as a hash would reject every honest download.
        assert_eq!(parse_sha256_etag("\"686897696a7c876b7e\""), None);
        assert_eq!(parse_sha256_etag("\"5d8c72a-1a3f\""), None);
        assert_eq!(parse_sha256_etag(""), None);
        // Right length, not hex.
        assert_eq!(parse_sha256_etag(&"z".repeat(64)), None);
    }

    #[test]
    fn an_unpinned_download_is_verified_against_the_origins_digest() {
        let content = b"model weights".to_vec();
        let upstream = hex::encode(Sha256::digest(&content));
        let dir = tempfile::tempdir().unwrap();
        let transport = Transport {
            content: content.clone(),
            upstream: Some(upstream),
        };
        let manager = ModelManager::new(&transport, dir.path());

        let outcome = manager
            .download_and_verify(&unpinned_spec(content.len() as u64), &mut |_, _| {})
            .unwrap();

        assert!(
            matches!(outcome, DownloadOutcome::UpstreamVerified { .. }),
            "{outcome:?}"
        );
    }

    #[test]
    fn an_unpinned_download_that_contradicts_the_origin_is_rejected() {
        // The case this exists for: bytes that are not what the origin says
        // they are — a truncated body or a swapped object — used to be
        // accepted unconditionally for any model without a pinned hash.
        let dir = tempfile::tempdir().unwrap();
        let transport = Transport {
            content: b"tampered weights".to_vec(),
            upstream: Some(hex::encode(Sha256::digest(b"real weights"))),
        };
        let manager = ModelManager::new(&transport, dir.path());

        let outcome = manager
            .download_and_verify(&unpinned_spec(16), &mut |_, _| {})
            .unwrap();

        assert_eq!(outcome, DownloadOutcome::HashMismatch);
        // Nothing is left behind for a later run to load.
        assert!(std::fs::read_dir(dir.path()).unwrap().next().is_none());
    }

    #[test]
    fn a_pinned_hash_still_wins_over_the_origins_claim() {
        // If the origin ever published a digest for the wrong bytes, the
        // compile-time pin is what must decide.
        let content = b"real weights".to_vec();
        let pinned: &'static str =
            Box::leak(hex::encode(Sha256::digest(&content)).into_boxed_str());
        let dir = tempfile::tempdir().unwrap();
        let transport = Transport {
            content: content.clone(),
            upstream: Some("b".repeat(64)),
        };
        let manager = ModelManager::new(&transport, dir.path());
        let spec = ModelSpec {
            name: "pinned-model",
            url: "https://example.com/model.gguf",
            sha256: Some(pinned),
            size_bytes: content.len() as u64,
        };

        let outcome = manager.download_and_verify(&spec, &mut |_, _| {}).unwrap();
        assert!(matches!(outcome, DownloadOutcome::Verified(_)), "{outcome:?}");
    }

    #[test]
    fn without_any_digest_the_download_is_still_trust_on_first_use() {
        let content = b"weights".to_vec();
        let dir = tempfile::tempdir().unwrap();
        let transport = Transport {
            content: content.clone(),
            upstream: None,
        };
        let manager = ModelManager::new(&transport, dir.path());

        let outcome = manager
            .download_and_verify(&unpinned_spec(content.len() as u64), &mut |_, _| {})
            .unwrap();

        assert!(matches!(outcome, DownloadOutcome::Unpinned { .. }), "{outcome:?}");
    }
}
