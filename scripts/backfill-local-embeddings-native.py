#!/usr/bin/env python3
"""Fast, resume-safe BGE-M3 backfill for local Apple Silicon development.

This intentionally bypasses the HTTP/Prisma path used by the application:
the model stays loaded in one MPS process and pgvector values are copied to a
temporary table before a bulk UPDATE. Existing embeddingBge values are never
overwritten.
"""

from __future__ import annotations

import argparse
import os
import signal
import time
from dataclasses import dataclass

os.environ.setdefault("HF_HOME", "/private/tmp/rag-hf-cache")

import numpy as np
import psycopg
import torch
from FlagEmbedding import BGEM3FlagModel
from huggingface_hub import snapshot_download
from pgvector.psycopg import register_vector


DSN = os.getenv(
    "DATABASE_URL_NATIVE",
    "postgresql://postgres:postgres@127.0.0.1:5433/lawrag",
)
MODEL = "BAAI/bge-m3"
MODEL_REVISION = "5617a9f61b028005a4858fdac845db406aefb181"
VECTOR_DIMENSION = 1024
EMBED_MAX_LENGTH = 512


@dataclass(frozen=True)
class Target:
    name: str
    table: str
    text_column: str
    index_name: str


TARGETS = {
    target.name: target
    for target in (
        Target(
            "law-chunks",
            "LawChunk",
            "text",
            "LawChunk_embeddingBge_hnsw_idx",
        ),
        Target(
            "user-memory",
            "UserMemory",
            "content",
            "UserMemory_embeddingBge_hnsw_idx",
        ),
        Target(
            "user-diary",
            "UserDiary",
            "entry",
            "UserDiary_embeddingBge_hnsw_idx",
        ),
    )
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--target",
        choices=[*TARGETS, "all"],
        default="all",
    )
    parser.add_argument("--fetch-size", type=int, default=2048)
    parser.add_argument("--gpu-batch-size", type=int, default=64)
    parser.add_argument(
        "--max-length",
        type=int,
        default=EMBED_MAX_LENGTH,
        help="Embedding truncation length; fixed at 512 for BGE cutover consistency.",
    )
    parser.add_argument(
        "--drop-indexes",
        action="store_true",
        help=(
            "Local-development speed optimization: temporarily drop/rebuild "
            "embeddingBge HNSW indexes. Never use on a shared/live database."
        ),
    )
    return parser.parse_args()


def quote_ident(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def index_sql(target: Target) -> str:
    return (
        f"CREATE INDEX IF NOT EXISTS {quote_ident(target.index_name)} "
        f"ON {quote_ident(target.table)} USING hnsw "
        '("embeddingBge" vector_cosine_ops)'
    )


def drop_index(target: Target) -> None:
    # Keep every destructive DDL operation in its own autocommit connection.
    # If the process is interrupted, there is no long-lived admin transaction
    # left behind that could block CREATE INDEX during the restoration path.
    with psycopg.connect(DSN, autocommit=True) as conn:
        conn.execute(f"DROP INDEX IF EXISTS {quote_ident(target.index_name)}")


def create_index(conn: psycopg.Connection, target: Target) -> None:
    started = time.perf_counter()
    print(f"{target.name}: rebuilding {target.index_name}...", flush=True)
    conn.execute(index_sql(target))
    conn.commit()
    print(
        f"{target.name}: index rebuilt in {time.perf_counter() - started:.1f}s",
        flush=True,
    )


def recreate_indexes(targets: list[Target]) -> list[str]:
    errors: list[str] = []
    for target in targets:
        conn: psycopg.Connection | None = None
        try:
            # One connection/transaction per index. If one CREATE INDEX fails,
            # its aborted transaction cannot poison restoration of the rest.
            conn = psycopg.connect(DSN)
            create_index(conn, target)
        except BaseException as exc:  # cleanup must continue across interrupts
            errors.append(f"{target.index_name}: {exc}")
        finally:
            if conn is not None:
                conn.close()
    return errors


def is_local_compose_database(dsn: str) -> bool:
    try:
        conninfo = psycopg.conninfo.conninfo_to_dict(dsn)
    except psycopg.ProgrammingError:
        return False

    if conninfo.get("service") or conninfo.get("hostaddr"):
        return False
    return (
        conninfo.get("host") in {"127.0.0.1", "localhost", "::1"}
        and conninfo.get("port") == "5433"
        and conninfo.get("dbname") == "lawrag"
    )


def raise_on_sigterm(_signum: int, _frame: object) -> None:
    # Convert normal process termination into the same exception-driven cleanup
    # path used for Ctrl-C. SIGKILL cannot be intercepted and remains outside
    # the guarantees of --drop-indexes.
    raise KeyboardInterrupt("received SIGTERM")


def backfill_target(
    model: BGEM3FlagModel,
    target: Target,
    fetch_size: int,
    gpu_batch_size: int,
    max_length: int,
) -> int:
    read_conn = psycopg.connect(DSN, autocommit=True)
    write_conn = psycopg.connect(DSN)
    register_vector(read_conn)
    register_vector(write_conn)
    write_conn.execute("SET synchronous_commit = off")

    temp_table = "tmp_bge_backfill"
    write_cur = write_conn.cursor()
    write_cur.execute(
        f"CREATE TEMP TABLE {temp_table} "
        "(id text PRIMARY KEY, source_text text NOT NULL, embedding vector(1024)) "
        "ON COMMIT PRESERVE ROWS"
    )
    write_conn.commit()

    table = quote_ident(target.table)
    text_column = quote_ident(target.text_column)
    total = 0
    batch_no = 0
    started = time.perf_counter()

    try:
        while True:
            rows = read_conn.execute(
                f"SELECT id, {text_column} FROM {table} "
                'WHERE "embeddingBge" IS NULL '
                f"ORDER BY length({text_column}), id LIMIT %s",
                (fetch_size,),
            ).fetchall()
            if not rows:
                break

            batch_no += 1
            ids = [row[0] for row in rows]
            texts = [row[1] for row in rows]

            embed_started = time.perf_counter()
            result = model.encode(
                texts,
                batch_size=gpu_batch_size,
                max_length=max_length,
            )
            torch.mps.synchronize()
            embed_seconds = time.perf_counter() - embed_started

            vectors = np.asarray(result["dense_vecs"], dtype=np.float32)
            expected_shape = (len(rows), VECTOR_DIMENSION)
            if vectors.shape != expected_shape:
                raise RuntimeError(
                    f"{target.name}: expected vectors {expected_shape}, got {vectors.shape}"
                )

            write_started = time.perf_counter()
            write_cur.execute(f"TRUNCATE {temp_table}")
            with write_cur.copy(
                f"COPY {temp_table} (id, source_text, embedding) FROM STDIN"
            ) as copy:
                for index, row_id in enumerate(ids):
                    copy.write_row((row_id, texts[index], vectors[index]))

            write_cur.execute(
                f"UPDATE {table} AS target "
                "SET \"embeddingBge\" = source.embedding "
                f"FROM {temp_table} AS source "
                "WHERE target.id = source.id "
                f"AND target.{text_column} = source.source_text "
                'AND target."embeddingBge" IS NULL'
            )
            updated = write_cur.rowcount
            write_conn.commit()
            write_seconds = time.perf_counter() - write_started

            total += updated
            elapsed = time.perf_counter() - started
            print(
                f"{target.name}: batch={batch_no} fetched={len(rows)} "
                f"updated={updated} total={total} "
                f"embed={embed_seconds:.2f}s write={write_seconds:.2f}s "
                f"rate={total / elapsed:.1f}/s",
                flush=True,
            )
    finally:
        write_cur.close()
        write_conn.close()
        read_conn.close()

    print(
        f"{target.name}: complete, updated={total}, "
        f"elapsed={time.perf_counter() - started:.1f}s",
        flush=True,
    )
    return total


def main() -> None:
    args = parse_args()
    if args.fetch_size <= 0 or args.gpu_batch_size <= 0:
        raise ValueError("batch sizes must be positive")
    if args.max_length != EMBED_MAX_LENGTH:
        raise ValueError(
            f"--max-length must be exactly {EMBED_MAX_LENGTH}; got {args.max_length}"
        )
    requested_model = os.getenv("EMBEDDING_MODEL", MODEL)
    if requested_model != MODEL:
        raise ValueError(
            f"EMBEDDING_MODEL must be exactly {MODEL}; got {requested_model}"
        )
    if not torch.backends.mps.is_available():
        raise RuntimeError("MPS is not available; run this script outside the sandbox")
    if args.drop_indexes and not is_local_compose_database(DSN):
        raise RuntimeError(
            "--drop-indexes is restricted to the local Compose database "
            "(127.0.0.1/localhost:5433/lawrag)"
        )

    selected = (
        list(TARGETS.values())
        if args.target == "all"
        else [TARGETS[args.target]]
    )

    # Load the model before mutating index state. A model/cache/MPS failure must
    # never leave a previously healthy database without its HNSW indexes.
    load_started = time.perf_counter()
    model_path = snapshot_download(repo_id=MODEL, revision=MODEL_REVISION)
    model = BGEM3FlagModel(model_path, use_fp16=True, devices="mps")
    print(
        f"model={MODEL}@{MODEL_REVISION} loaded in "
        f"{time.perf_counter() - load_started:.1f}s; "
        f"MPS={torch.backends.mps.is_available()}",
        flush=True,
    )

    dropped_targets: list[Target] = []
    failure: BaseException | None = None
    previous_sigterm_handler = signal.getsignal(signal.SIGTERM)
    signal.signal(signal.SIGTERM, raise_on_sigterm)
    try:
        if args.drop_indexes:
            for target in selected:
                # Register restoration before DROP. If the server commits the
                # drop but the client is interrupted before returning, cleanup
                # still attempts CREATE INDEX IF NOT EXISTS for this target.
                dropped_targets.append(target)
                drop_index(target)

        for target in selected:
            backfill_target(
                model,
                target,
                args.fetch_size,
                args.gpu_batch_size,
                args.max_length,
            )
    except BaseException as exc:
        failure = exc
    finally:
        restore_errors = (
            recreate_indexes(dropped_targets)
            if dropped_targets
            else []
        )
        signal.signal(signal.SIGTERM, previous_sigterm_handler)

    if restore_errors:
        message = "failed to restore HNSW indexes: " + "; ".join(restore_errors)
        if failure is not None:
            raise RuntimeError(f"{message}; original error: {failure}") from failure
        raise RuntimeError(message)
    if failure is not None:
        raise failure


if __name__ == "__main__":
    main()
