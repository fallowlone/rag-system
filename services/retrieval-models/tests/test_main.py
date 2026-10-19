"""Contract tests for the retrieval-models service.

Run WITHOUT entering the lifespan (no ~5 GB model download): validation
shapes (422/400) are exercised directly, and the 200 paths run against a
stubbed ModelRuntime. What this pins:

- request caps (embed batch, rerank docs/topK, text length) — oversized
  requests hold the global inference lock past Node's timeout;
- /health key names AND pinned values vs the Node cutover gate
  (local-embedding-cutover.ts RetrievalHealthSchema + the
  local-retrieval.constants.ts revisions) — update both sides together.
"""

import pytest
from fastapi.testclient import TestClient

from app.main import (
    EXPECTED_EMBEDDING_MODEL,
    EXPECTED_EMBEDDING_REVISION,
    EXPECTED_RERANKER_MODEL,
    EXPECTED_RERANKER_REVISION,
    RerankResult,
    app,
    runtime,
)


@pytest.fixture()
def client():
    # Plain instantiation, deliberately NOT a context manager: entering it
    # would run the lifespan and download/load ~5 GB of models.
    return TestClient(app, raise_server_exceptions=False)


def test_embed_rejects_empty_list(client):
    assert client.post("/embed", json={"texts": []}).status_code == 422


def test_embed_rejects_empty_and_oversize_text(client):
    assert client.post("/embed", json={"texts": [""]}).status_code == 422
    assert client.post("/embed", json={"texts": ["x" * 20_001]}).status_code == 422


def test_embed_rejects_over_batch_cap(client):
    # 33 texts exceed the 32 cap (Node never sends more than 32).
    response = client.post("/embed", json={"texts": ["a"] * 33})
    assert response.status_code == 422


def test_embed_accepts_max_batch_shape(client, monkeypatch):
    monkeypatch.setattr(runtime, "embed", lambda texts: [[0.1] * 1024 for _ in texts])
    response = client.post("/embed", json={"texts": ["a"] * 32})
    assert response.status_code == 200
    assert len(response.json()["embeddings"]) == 32


def test_rerank_rejects_empty_overcap_and_bad_topk(client):
    base = {"query": "q", "documents": ["d"]}
    assert client.post("/rerank", json={**base, "documents": []}).status_code == 422
    assert (
        client.post("/rerank", json={**base, "documents": ["d"] * 49}).status_code
        == 422
    )
    assert client.post("/rerank", json={**base, "topK": 0}).status_code == 422
    assert client.post("/rerank", json={**base, "topK": 49}).status_code == 422
    assert (
        client.post("/rerank", json={"query": "", "documents": ["d"]}).status_code
        == 422
    )


def test_rerank_accepts_real_world_max(client, monkeypatch):
    # Node's real max is 33 candidates (20 law + 13 docvault); 48 is headroom.
    monkeypatch.setattr(
        runtime,
        "rerank",
        lambda query, documents, top_k: [
            RerankResult(index=index, score=1.0 / (index + 1))
            for index in range(min(top_k, len(documents)))
        ],
    )
    response = client.post(
        "/rerank",
        json={"query": "q", "documents": ["d"] * 33, "topK": 10},
    )
    assert response.status_code == 200
    assert len(response.json()["results"]) == 10


def test_health_keys_and_pinned_values_match_node_gate(client, monkeypatch):
    # Unloaded runtime would 500 — stub the loaded state, not the endpoint.
    monkeypatch.setattr(runtime, "embedding", object())
    monkeypatch.setattr(runtime, "reranker", object())
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "embeddingModel": "BAAI/bge-m3",
        "embeddingRevision": "5617a9f61b028005a4858fdac845db406aefb181",
        "rerankerModel": "BAAI/bge-reranker-v2-m3",
        "rerankerRevision": "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e",
    }
    # The module constants are the values above — a silent edit breaks this.
    assert EXPECTED_EMBEDDING_MODEL == "BAAI/bge-m3"
    assert EXPECTED_EMBEDDING_REVISION == "5617a9f61b028005a4858fdac845db406aefb181"
    assert EXPECTED_RERANKER_MODEL == "BAAI/bge-reranker-v2-m3"
    assert EXPECTED_RERANKER_REVISION == "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e"


def test_health_fails_closed_when_unloaded(client):
    assert runtime.embedding is None
    assert client.get("/health").status_code == 500


def test_embed_rejects_with_503_once_admission_slots_are_gone(client, monkeypatch):
    # The per-request caps bound one request's work; nothing bounded the
    # QUEUE. With the Node client timing out at 10 s and retrying 3 times
    # against a global inference lock, an unbounded queue turns one logical
    # request into work nobody will read — a fast 503 lets its backoff work.
    monkeypatch.setattr(runtime, "embed", lambda texts: [[0.0] * 1024])

    held = []
    try:
        while runtime.slots.acquire(blocking=False):
            held.append(True)

        response = client.post("/embed", json={"texts": ["hallo"]})
        assert response.status_code == 503
        assert response.headers.get("Retry-After") == "1"
    finally:
        for _ in held:
            runtime.slots.release()

    # Slots are restored, so the next caller is served normally.
    assert client.post("/embed", json={"texts": ["hallo"]}).status_code == 200


def test_admission_slot_is_released_when_inference_raises(client, monkeypatch):
    def boom(texts):
        raise RuntimeError("model exploded")

    monkeypatch.setattr(runtime, "embed", boom)

    before = _free_slots()
    assert client.post("/embed", json={"texts": ["hallo"]}).status_code == 500
    # A leaked slot per failure would saturate the service permanently after
    # MAX_ADMITTED_REQUESTS errors, with no way back short of a restart.
    assert _free_slots() == before


def _free_slots() -> int:
    acquired = 0
    while runtime.slots.acquire(blocking=False):
        acquired += 1
    for _ in range(acquired):
        runtime.slots.release()
    return acquired
