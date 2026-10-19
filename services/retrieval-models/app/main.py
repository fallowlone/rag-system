import os
import math
import threading
from contextlib import asynccontextmanager, contextmanager
from typing import Annotated, Any

import torch
from fastapi import FastAPI, HTTPException
from FlagEmbedding import BGEM3FlagModel, FlagReranker
from huggingface_hub import snapshot_download
from pydantic import BaseModel, Field

EXPECTED_EMBEDDING_MODEL = "BAAI/bge-m3"
EXPECTED_RERANKER_MODEL = "BAAI/bge-reranker-v2-m3"
EXPECTED_EMBEDDING_REVISION = "5617a9f61b028005a4858fdac845db406aefb181"
EXPECTED_RERANKER_REVISION = "953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e"
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", EXPECTED_EMBEDDING_MODEL)
RERANKER_MODEL = os.getenv("RERANKER_MODEL", EXPECTED_RERANKER_MODEL)
EMBEDDING_DIMENSION = 1024
EMBED_BATCH_SIZE = int(os.getenv("EMBED_BATCH_SIZE", "16"))
EMBED_MAX_LENGTH = int(os.getenv("EMBED_MAX_LENGTH", "512"))
MAX_TEXT_CHARS = 20_000
# Admitted requests (the one holding the inference lock plus those waiting).
#
# The per-request caps below bound how much work ONE request can ask for;
# they say nothing about how many requests can pile up. Every call serializes
# on the global inference lock while the Node client gives up after 10 s and
# retries up to 3 times — and an abandoned request keeps running, because a
# sync FastAPI endpoint in the threadpool never learns the client hung up.
# Under load that turns one logical request into three units of work whose
# results nobody will read. A fast 503 lets the caller's backoff do its job
# instead. Judgement call, not a tuned number: enough to absorb a short burst,
# small enough that the tail of the queue can still be served inside the
# client's timeout.
MAX_ADMITTED_REQUESTS = int(os.getenv("MAX_ADMITTED_REQUESTS", "4"))

if EMBEDDING_MODEL != EXPECTED_EMBEDDING_MODEL:
    raise RuntimeError(
        f"EMBEDDING_MODEL must be {EXPECTED_EMBEDDING_MODEL}; got {EMBEDDING_MODEL}"
    )
if RERANKER_MODEL != EXPECTED_RERANKER_MODEL:
    raise RuntimeError(
        f"RERANKER_MODEL must be {EXPECTED_RERANKER_MODEL}; got {RERANKER_MODEL}"
    )
if not 1 <= MAX_ADMITTED_REQUESTS <= 64:
    raise RuntimeError("MAX_ADMITTED_REQUESTS must be between 1 and 64")
if not 1 <= EMBED_BATCH_SIZE <= 64:
    raise RuntimeError("EMBED_BATCH_SIZE must be between 1 and 64")
if EMBED_MAX_LENGTH != 512:
    raise RuntimeError(
        "EMBED_MAX_LENGTH must be exactly 512 for BGE cutover consistency"
    )

BoundedText = Annotated[str, Field(min_length=1, max_length=MAX_TEXT_CHARS)]


class EmbedRequest(BaseModel):
    # 32, not 64: the Node caller never sends more than 32 texts per request
    # (its batch size), and each accepted request holds the global inference
    # lock across sequential model batches — oversized requests stall chat
    # recall behind ingest traffic past Node's timeout.
    texts: list[BoundedText] = Field(min_length=1, max_length=32)


class EmbedResponse(BaseModel):
    embeddings: list[list[float]]


class RerankRequest(BaseModel):
    query: BoundedText
    # 48, not 128: the Node caller sends at most 33 candidates, and an
    # accepted 128-doc request is one 128x512 cross-encoder batch on CPU —
    # tens of seconds, far past Node's 10s timeout, while holding the lock
    # that embed traffic waits on.
    documents: list[BoundedText] = Field(min_length=1, max_length=48)
    topK: int = Field(ge=1, le=48)


class RerankResult(BaseModel):
    index: int
    score: float


class RerankResponse(BaseModel):
    results: list[RerankResult]


class ModelRuntime:
    def __init__(self) -> None:
        self.embedding: BGEM3FlagModel | None = None
        self.reranker: FlagReranker | None = None
        self.lock = threading.Lock()
        self.slots = threading.BoundedSemaphore(MAX_ADMITTED_REQUESTS)

    @contextmanager
    def admit(self):
        """Rejects immediately instead of queueing without bound.

        Non-blocking on purpose: a request that waits here is a request the
        client has probably already abandoned, and serving it costs the same
        inference time as serving a live one.
        """
        if not self.slots.acquire(blocking=False):
            raise HTTPException(
                status_code=503,
                detail="retrieval models are saturated; retry shortly",
                headers={"Retry-After": "1"},
            )
        try:
            yield
        finally:
            self.slots.release()

    def load(self) -> None:
        use_fp16 = torch.cuda.is_available() or torch.backends.mps.is_available()
        # The import-time pins above guarantee these equal the EXPECTED_*
        # constants — use the env-provided names so the validation is
        # load-bearing, not decorative.
        embedding_path = self._download(EMBEDDING_MODEL, EXPECTED_EMBEDDING_REVISION)
        reranker_path = self._download(RERANKER_MODEL, EXPECTED_RERANKER_REVISION)
        try:
            self.embedding = BGEM3FlagModel(embedding_path, use_fp16=use_fp16)
        except Exception as exc:
            raise RuntimeError(
                f"failed to load embedding model {EMBEDDING_MODEL} from {embedding_path}: {exc}"
            ) from exc
        try:
            self.reranker = FlagReranker(reranker_path, use_fp16=use_fp16)
        except Exception as exc:
            raise RuntimeError(
                f"failed to load reranker model {RERANKER_MODEL} from {reranker_path}: {exc}"
            ) from exc

    @staticmethod
    def _download(repo_id: str, revision: str) -> str:
        try:
            return snapshot_download(repo_id=repo_id, revision=revision)
        except Exception as exc:
            raise RuntimeError(
                f"failed to download {repo_id}@{revision} "
                f"(check network access and disk space for the ~5 GB model cache): {exc}"
            ) from exc

    def embed(self, texts: list[str]) -> list[list[float]]:
        model = self._embedding()
        with self.lock:
            result: dict[str, Any] = model.encode(
                texts,
                batch_size=EMBED_BATCH_SIZE,
                max_length=EMBED_MAX_LENGTH,
            )
        dense_vectors = result.get("dense_vecs")
        if dense_vectors is None:
            raise RuntimeError("BGE-M3 response did not contain dense_vecs")
        vectors = [[float(value) for value in vector] for vector in dense_vectors]
        if len(vectors) != len(texts):
            raise RuntimeError(
                f"{EMBEDDING_MODEL} returned {len(vectors)} vectors for {len(texts)} texts"
            )
        for vector in vectors:
            if len(vector) != EMBEDDING_DIMENSION:
                raise RuntimeError(
                    f"{EMBEDDING_MODEL} returned {len(vector)} dimensions; "
                    f"expected {EMBEDDING_DIMENSION}"
                )
            if not all(math.isfinite(value) for value in vector):
                raise RuntimeError(f"{EMBEDDING_MODEL} returned a non-finite embedding")
        return vectors

    def rerank(
        self, query: str, documents: list[str], top_k: int
    ) -> list[RerankResult]:
        model = self._reranker()
        pairs = [[query, document] for document in documents]
        with self.lock:
            raw_scores = model.compute_score(pairs, normalize=True)

        if isinstance(raw_scores, (int, float)):
            scores = [float(raw_scores)]
        else:
            scores = [float(score) for score in raw_scores]
        if len(scores) != len(documents):
            raise RuntimeError(
                f"{RERANKER_MODEL} returned {len(scores)} scores for {len(documents)} documents"
            )
        if not all(math.isfinite(score) for score in scores):
            raise RuntimeError(f"{RERANKER_MODEL} returned a non-finite score")

        ranked = sorted(enumerate(scores), key=lambda item: item[1], reverse=True)
        return [
            RerankResult(index=index, score=score)
            for index, score in ranked[: min(top_k, len(ranked))]
        ]

    def _embedding(self) -> BGEM3FlagModel:
        if self.embedding is None:
            raise RuntimeError("embedding model is not loaded")
        return self.embedding

    def _reranker(self) -> FlagReranker:
        if self.reranker is None:
            raise RuntimeError("reranker model is not loaded")
        return self.reranker


runtime = ModelRuntime()


@asynccontextmanager
async def lifespan(_: FastAPI):
    runtime.load()
    yield


app = FastAPI(title="rag-system retrieval models", lifespan=lifespan)


@app.get("/health")
def health() -> dict[str, str]:
    runtime._embedding()
    runtime._reranker()
    return {
        "status": "ok",
        "embeddingModel": EMBEDDING_MODEL,
        "embeddingRevision": EXPECTED_EMBEDDING_REVISION,
        "rerankerModel": RERANKER_MODEL,
        "rerankerRevision": EXPECTED_RERANKER_REVISION,
    }


@app.post("/embed", response_model=EmbedResponse)
def embed(request: EmbedRequest) -> EmbedResponse:
    with runtime.admit():
        return EmbedResponse(embeddings=runtime.embed(request.texts))


@app.post("/rerank", response_model=RerankResponse)
def rerank(request: RerankRequest) -> RerankResponse:
    with runtime.admit():
        return RerankResponse(
            results=runtime.rerank(request.query, request.documents, request.topK),
        )
