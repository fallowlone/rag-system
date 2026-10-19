//! End-to-end sync test against a real localhost HTTP stub of the NestJS
//! backend. Exercises the production `HttpTransport` (real ureq over TCP):
//! propose pairing → poll claim → push extraction → capture suggested
//! tasks → confirm task.
//!
//! The stub implements just enough of /app/v1 to play the backend's part —
//! validating this end-to-end contract without a running Postgres.

use dokumente_core::crypto::{InMemoryProvider, KeyProvider, TOKEN_ACCOUNT};
use dokumente_core::store::Store;
use dokumente_core::sync::{HttpTransport, PairingProposal, SyncClient, SyncReport};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::{Arc, Mutex};

#[allow(dead_code)] // method/body are asserted in the stub handler; kept for diagnostics
#[derive(Debug, Clone)]
struct RecordedRequest {
    method: String,
    path: String,
    body: String,
    authorization: Option<String>,
}

struct StubBackend {
    base_url: String,
    requests: Arc<Mutex<Vec<RecordedRequest>>>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl StubBackend {
    fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let port = listener.local_addr().expect("local addr").port();
        let requests: Arc<Mutex<Vec<RecordedRequest>>> = Arc::new(Mutex::new(Vec::new()));

        let requests_thread = Arc::clone(&requests);
        let handle = std::thread::spawn(move || {
            // The test flow makes exactly 4 requests.
            for _ in 0..4 {
                match listener.accept() {
                    Ok((stream, _)) => handle_connection(&stream, &requests_thread),
                    Err(_) => break,
                }
            }
        });

        Self {
            base_url: format!("http://127.0.0.1:{port}"),
            requests,
            handle: Some(handle),
        }
    }

    fn snapshot(&self) -> Vec<RecordedRequest> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for StubBackend {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn handle_connection(stream: &TcpStream, requests: &Arc<Mutex<Vec<RecordedRequest>>>) {
    let mut reader = stream.try_clone().expect("clone stream");

    // Read the request head byte-by-byte until the blank line after headers.
    let mut head = Vec::new();
    let mut buf = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => head.push(buf[0]),
        }
    }

    let head_text = String::from_utf8_lossy(&head).into_owned();
    let mut lines = head_text.lines();
    let request_line = lines.next().unwrap_or_default().to_string();
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or_default().to_string();
    let path = parts.next().unwrap_or_default().to_string();

    let mut content_length = 0usize;
    let mut authorization: Option<String> = None;
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            match key.trim().to_ascii_lowercase().as_str() {
                "content-length" => content_length = value.trim().parse().unwrap_or(0),
                "authorization" => authorization = Some(value.trim().to_string()),
                _ => {}
            }
        }
    }

    let mut body = vec![0u8; content_length];
    if content_length > 0 {
        let _ = reader.read_exact(&mut body);
    }
    let body = String::from_utf8_lossy(&body).into_owned();

    requests.lock().unwrap().push(RecordedRequest {
        method: method.clone(),
        path: path.clone(),
        body: body.clone(),
        authorization,
    });

    let (status, response_body) = route(&method, &path, &body);
    let response = format!(
        "HTTP/1.1 {status} OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        response_body.len(),
        response_body
    );
    let mut out = stream.try_clone().expect("clone for write");
    let _ = out.write_all(response.as_bytes());
    let _ = out.flush();
}

fn route(method: &str, path: &str, body: &str) -> (u16, String) {
    if method == "POST" && path == "/app/v1/auth/pair-status" {
        let payload: serde_json::Value = serde_json::from_str(body).unwrap();
        assert_eq!(payload["code"].as_str().unwrap().len(), 6, "6-digit code");
        assert_eq!(
            payload["secret"].as_str().unwrap().len(),
            64,
            "256-bit hex secret in the POST body, never in the URL"
        );
        return (
            200,
            r#"{"claimed":true,"token":"test-token-123","sessionId":"sess-1","userId":"user-1"}"#
                .to_string(),
        );
    }
    match (method, path) {
        ("POST", "/app/v1/auth/pair-propose") => {
            let payload: serde_json::Value = serde_json::from_str(body).unwrap();
            assert_eq!(payload["code"].as_str().unwrap().len(), 6, "6-digit code");
            assert!(payload["deviceName"].is_string(), "deviceName present");
            assert_eq!(
                payload["secret"].as_str().unwrap().len(),
                64,
                "256-bit hex secret"
            );
            (200, r#"{"proposed":true,"expiresIn":60}"#.to_string())
        }
        ("POST", "/app/v1/documents") => {
            let payload: serde_json::Value = serde_json::from_str(body).unwrap();
            assert_eq!(
                payload["sourceHash"].as_str().unwrap().len(),
                64,
                "sha256 hash"
            );
            assert_eq!(payload["category"], "jobcenter");
            assert_eq!(payload["isActive"], true);
            (
                201,
                r#"{"documentId":"remote-doc-1","created":true,"factsStored":2,"deadlinesCreated":1,"suggestedTasks":["Nachweis beim Jobcenter einreichen"]}"#.to_string(),
            )
        }
        ("POST", "/app/v1/tasks") => {
            let payload: serde_json::Value = serde_json::from_str(body).unwrap();
            assert_eq!(payload["title"], "Nachweis beim Jobcenter einreichen");
            assert_eq!(payload["sourceDocumentId"], "remote-doc-1");
            (
                201,
                r#"{"id":"task-1","title":"Nachweis beim Jobcenter einreichen","sourceType":"document","sourceDocumentId":"remote-doc-1"}"#.to_string(),
            )
        }
        _ => (404, r#"{"message":"Not Found"}"#.to_string()),
    }
}

#[test]
fn full_sync_flow_over_real_http() {
    let backend = StubBackend::start();
    let base_url = backend.base_url.clone();

    let keys = std::sync::Arc::new(InMemoryProvider::new());
    let store = std::sync::Mutex::new(Store::open_in_memory(&*keys).unwrap());

    let client = SyncClient::new(
        std::sync::Arc::new(HttpTransport::new(&base_url)),
        std::sync::Arc::clone(&keys) as std::sync::Arc<dyn KeyProvider>,
    );

    // 1. Reverse pairing: device proposes, user claims in Telegram (the stub
    //    plays the claimed poll), token lands in the keychain.
    let proposal = PairingProposal::generate();
    assert_eq!(proposal.code.len(), 6, "6-digit code");
    assert_eq!(proposal.secret.len(), 64, "256-bit hex secret");
    assert!(proposal.display_code().starts_with("DOK-"));
    client.propose_pairing(&proposal, "MacBook Pro").unwrap();
    assert!(client.poll_pairing_claim(&proposal).unwrap(), "claimed");
    assert_eq!(
        keys.get(TOKEN_ACCOUNT).unwrap(),
        Some("test-token-123".into())
    );

    // 2. Queue an extraction (as if the local model had run)
    store
        .lock()
        .unwrap()
        .insert_document("doc-1", &"c".repeat(64), None, "pdf", "raw text", None)
        .unwrap();
    store
        .lock()
        .unwrap()
        .save_extraction(
            "doc-1",
            &format!(
                r#"{{"sourceHash":"{}","category":"jobcenter","facts":[],"deadlines":[],"obligations":["Jobcenter anrufen"],"addresses":[],"amounts":[],"tags":[],"isActive":true}}"#,
                "c".repeat(64)
            ),
        )
        .unwrap();

    // 3. Sync the outbox
    let report = client.push_pending(&store, 10).unwrap();
    assert_eq!(
        report,
        SyncReport {
            sent: 1,
            retried: 0,
            parked: 0,
            quality_flags: vec![],
        }
    );
    assert_eq!(
        store
            .lock()
            .unwrap()
            .get_document("doc-1")
            .unwrap()
            .unwrap()
            .status,
        "synced"
    );

    // 4. The backend's suggested task was captured locally
    let suggested = store.lock().unwrap().list_suggested_tasks().unwrap();
    assert_eq!(suggested.len(), 1);
    assert_eq!(suggested[0].title, "Nachweis beim Jobcenter einreichen");
    assert_eq!(suggested[0].remote_document_id, "remote-doc-1");

    // 5. User confirms → created remotely, linked to the real document.
    let claimed = store
        .lock()
        .unwrap()
        .claim_suggested_task(suggested[0].id)
        .unwrap()
        .expect("task pending and claimable");
    assert_eq!(claimed.status, "confirmed");
    client
        .create_task(&claimed.title, &claimed.remote_document_id)
        .unwrap();

    // 6. Verify what the backend received, end to end
    let requests = backend.snapshot();
    assert_eq!(requests.len(), 4, "propose + poll + ingest + task");
    let paths: Vec<&str> = requests.iter().map(|r| r.path.as_str()).collect();
    assert_eq!(paths[0], "/app/v1/auth/pair-propose");
    assert_eq!(paths[1], "/app/v1/auth/pair-status");
    assert!(
        !paths[1].contains("secret"),
        "secret must not leak into the URL: {}",
        paths[1]
    );
    assert_eq!(paths[2], "/app/v1/documents");
    assert_eq!(paths[3], "/app/v1/tasks");
    assert_eq!(
        requests[2].authorization.as_deref(),
        Some("Bearer test-token-123")
    );
}
