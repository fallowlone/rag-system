# Retrieval golden-set eval

Small offline regression harness for `RetrievalService.searchUnified()`
(embed → pgvector search → rerank → lawId/room filters), the retrieval path
used by the production answer pipeline. Lets us catch retrieval regressions
(e.g. category/law-room filter changes, rerank model changes) without an LLM
judge or a live answer pass.

## Files

- `golden-set.json` — 44 hand-written questions (22 ru / 22 de), each with the
  single expected `{ lawId, normKey }` chunk that should be retrieved.
- `../scripts/eval-golden-set.ts` — runs every question through
  `RetrievalService.searchUnified()` against a live DB and reports
  recall@k / precision@k / NDCG@k / MRR and latency, broken down by
  lang / type / category. The result file records the exact embedding and
  reranking provider ids used for the run.
- `results/` — per-run JSON output (gitignored; regenerate locally).

## Golden-set composition

| axis | breakdown |
|---|---|
| lang | ru: 22, de: 22 |
| type | explicit_law: 15, category_only: 13, conversational: 16 |
| category | mietvertrag: 4, jobcenter: 4, visa: 5, (none): 31 |
| target lawId | bgb: 11, sgb_2: 8, aufenthg_2004: 7, sgb_12: 5, stgb: 5, kschg: 4, asylblg: 2, bkgg_1996: 1, asylvfg_1992: 1 |

Question types:

- **explicit_law** — query cites a specific `§` and law name/abbreviation
  (exercises `LAW_ABBREVIATIONS` § detection in `retrieval.service.ts`).
- **category_only** — query implies one of the retrieval categories
  (`mietvertrag` / `jobcenter` / `visa`), passed as the `category` param
  (exercises `CATEGORY_LAW_DEFAULTS` / `CATEGORY_TO_USER_ROOM`).
- **conversational** — free-form question with no category hint, relying on
  pure semantic search + rerank across the whole law corpus.

`relevant` chunks and normKeys were verified against the live seeded
`LawChunk` table, e.g.:

```sh
docker exec rag-system-postgres-1 psql -U postgres -d lawrag -c \
  "SELECT normKey FROM \"LawChunk\" WHERE \"lawId\"='bgb' AND heading ILIKE '%Mieterhöhung%'"
```

Two questions (`q17`, `q37`) intentionally document a known retrieval gap
rather than being "fixable" by editing the golden set — see their `note`
fields and the harness output below.

**Matching granularity:** the harness strips only the `_cN` chunk suffix when
comparing normKeys (`normalizeNormKey` in `scripts/eval-golden-set.ts`), so
matching happens at **paragraph level** (`..._pN`), not article level. All 44
current questions target `_p0_c0`, so this makes no difference today — but if
you add a question for a multi-paragraph norm, the expected normKey must name
the exact paragraph (`..._p1`), not just the article prefix.

## Running

Requires the local docker-compose Postgres (with the seeded law corpus), Redis,
and the `retrieval-models` service. The harness checks BGE embedding-column
coverage before running and refuses partial indexes by default.

```sh
npm run eval:retrieval
# optional flags:
#   --topk 5,10            # which k values to compute recall/precision@k for
#   --filter q01,q02        # only run specific question ids
#   --out eval/results/run.json
#   --allow-partial-index   # diagnostics only; never use for provider comparison
```

### BGE index preparation

After the parallel BGE migration has been applied, fill the new BGE columns
before evaluating. The backfill is resume-safe and only processes rows where
`embeddingBge IS NULL`.

```sh
npx prisma migrate deploy
```

```sh
docker compose up -d retrieval-models
```

```sh
npm run embeddings:backfill-local
```

For a production image, the same backfill is compiled into `dist` and does
not require `ts-node` or the source `scripts/` directory:

```sh
npm run embeddings:backfill-local:prod
```

Existing populated databases require a hard staged cutover. Do not start the
new BGE-only application immediately after applying the schema migration:

0. Before downtime, make sure PostgreSQL and Redis are running without
   recreating existing containers, then start the pinned `retrieval-models`
   image. The deploy workflow uses `docker compose up --no-recreate` for the
   stateful services because Redis persistence is intentionally disabled and a
   recreate would discard live BullMQ/Redis state.
1. Confirm PostgreSQL has enough free disk/WAL headroom for the parallel
   1024-d vectors plus a second LawChunk HNSW index (the local seeded corpus
   temporarily carries roughly another 2.5 GB HNSW index, before WAL/dead-row
   overhead). The deploy workflow enforces this before downtime by requiring
   free space >= `max(8 GiB, 2 * pg_database_size(current_database()))` on the
   Postgres data filesystem; `CUTOVER_MIN_FREE_BYTES` can raise that floor.
2. Stop/quiesce every pre-BGE writer: app instances, Telegram polling, BullMQ
   workers, and schedulers. Old writers must stay stopped until cutover
   verification succeeds.
3. Apply `prisma migrate deploy` using the new app image.
4. Run `node dist/cli/backfill-local-embeddings.js` using that same image.
   The deploy workflow gives this bulk job a 300 s retrieval timeout; the
   interactive app remains capped to a much shorter timeout.
5. Run `node dist/cli/verify-local-embedding-cutover.js`. It fails unless all
   persisted rows have `embeddingBge`, all three expected HNSW cosine indexes
   are ready/valid, and `/health` reports the exact pinned embedding/reranker
   model revisions.
6. Start the new application. `src/main.ts` repeats the same cutover preflight
   before `NestFactory.create()`, so Telegram/BullMQ/module lifecycle side
   effects cannot start on an incomplete cutover.

This is an intentional hard cutover, not a mixed-version rollout. New code
writes BGE vectors only, so rolling back to a pre-BGE binary after new writes
requires restoring a compatible database snapshot or an explicit reverse
data migration; do not rely on the retained legacy column as rollback safety.

Then run the production retrieval stack against the complete BGE index:

```sh
npm run eval:retrieval
```

The report includes `recall@5`, `recall@10`, `ndcg@5`, `ndcg@10`, MRR,
mean latency, p50, and p95. The timestamped JSON result is written to
`eval/results/`. Never treat a partial-index diagnostic run as a quality
baseline.

The harness calls `searchUnified()` with no `userId` (mirrors an
anonymous/first-turn query), so it only ever exercises the law-corpus
retrieval path — `searchUnified()` fail-closes the docvault search when
`userId` is absent (see commit `8b70d1e`).

It builds a minimal standalone Nest module (`PrismaModule` + `CacheModule` +
the local embedding provider/service, plus `RetrievalService` +
`PalaceNavigationService`) rather than importing `IngestionModule` or
`RagModule`. The production cutover preflight lives in `src/main.ts`, not a
Nest module lifecycle hook, so diagnostic `--allow-partial-index` runs can
still intentionally exercise a partial law index while preserving the exact
embedding/reranking providers used by retrieval.

## BGE cutover result (2026-09-04)

Full live run against a 100% BGE-indexed law corpus (`316468/316468` non-docvault
law chunks), using `BAAI/bge-m3` + `BAAI/bge-reranker-v2-m3`:

```text
n=44  recall@5=0.568  recall@10=0.682  ndcg@5=0.440  ndcg@10=0.476  mrr=0.412
p50=3422ms  p95=4723ms  # latest revision-aware cold-cache run
```

Result: `eval/results/bge-m3-cutover-2026-09-04.json`.

An earlier warm-cache verification of the same BGE quality result measured
`p50=44ms`, `p95=334ms`; those latency numbers are not the contents of the
current result JSON.

## Baseline (2026-07-06, live seeded DB, no changes to `src/`)

```
n=44  recall@5=0.477  recall@10=0.545  mrr=0.282

by lang:
  ru  n=22  recall@5=0.364  recall@10=0.455  mrr=0.236
  de  n=22  recall@5=0.591  recall@10=0.636  mrr=0.328

by type:
  explicit_law    n=15  recall@5=0.733  recall@10=0.800  mrr=0.437
  category_only   n=13  recall@5=0.308  recall@10=0.462  mrr=0.085
  conversational  n=16  recall@5=0.375  recall@10=0.375  mrr=0.297
```
