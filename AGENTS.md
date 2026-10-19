## Layout

- `src/` — NestJS 10 backend (`src/main.ts` → `src/app.module.ts`). Modules: `rag/`, `ingestion/`, `memory/`, `conversation/`, `telegram/`, `app-api/` (`/app/v1/*` for macOS client), `admin/`, `batch/`, `documents/`, `pdf/`, `health/`, `notifications/`.
- `apps/macos/` — Rust Cargo workspace (`crates/dokumente-core` lib + `src-tauri` shell). By design, raw document text stays on the device and only extraction JSON syncs.
- `apps/macos/ui/` — React 18 + Vite + Tailwind v4 frontend; build output `ui/dist` = Tauri `frontendDist`.
- `prisma/` — PostgreSQL 16 + pgvector schema + migrations. `scripts/` — eval (`eval-golden-set.ts`), backfills, `app-sync-e2e.sh` (live backend check).

## Commands (run from repo root unless noted)

```bash
docker compose up -d postgres redis   # DB + Redis; .env URLs must match compose-mapped host ports
npx prisma generate                   # after any schema.prisma change
npx prisma migrate dev                # local schema change (creates migration); deploy uses `migrate deploy`
npx tsc --noEmit && npx eslint "src/**/*.ts" && npx jest --ci && npm run build  # CI order (see .github/workflows/ci.yml)
npx jest src/rag/retrieval.service.spec.ts   # single suite; rootDir is src/, specs are `*.spec.ts`
npm --prefix apps/macos/ui run build  # UI typecheck + vite build
(cd apps/macos && cargo test && cargo clippy --workspace)  # Rust; repeat with `--features llama` when touching llm/
bash scripts/app-sync-e2e.sh          # live /app/v1 sync check vs real backend+Redis (no LLM cost)
```

## Critical rules

- Never edit existing `prisma/migrations/*` — always a new migration. Docker CMD runs `prisma migrate deploy` on boot.
- Env is validated once at boot (`src/config/env.schema.ts` via `src/config/validate-env.ts`, imported before `app.module`). Required: `DATABASE_URL`, `REDIS_URL`, `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `LOCAL_RETRIEVAL_URL`. Embeddings/reranking are local open-source BGE models; there is no hosted retrieval-provider fallback. `ADMIN_API_TOKEN`/`RAG_BOT_SECRET` stay optional — their guards fail closed when unset.
- No `any` (eslint error), no `console.log` (use NestJS `Logger`), no floating promises (`no-floating-promises` + `require-await` are errors). No `!` without a comment.
- No business logic in controllers: Zod `safeParse` → `BadRequestException(error.flatten())`, then delegate to a service (see `AdminController` / `app-api/*.controller.ts`). Global `ValidationPipe({whitelist, transform})`, global `ThrottlerGuard`, per-route `@Throttle`, 20 MB body limit.
- Services expose interfaces in adjacent `types.ts`; batch external calls (`Promise.all`, Message Batches) instead of per-item loops.
- All Codex/Haiku prompts use XML tags (`<already_known>`, `<user_documents_summary>`, …). New user text reaching an LLM goes through `InjectionClassifierService` first.
- Stop after each step, wait for confirmation.

## Gotchas (hard-earned, do not rediscover)

- `tsconfig.json` excludes `apps/` — CMake emits `.ts` files under `apps/macos/target` that break `tsc`; `.dockerignore` also excludes `apps/`. If `nest build` emits `.d.ts` without `main.js`, clear stale state: `rm -rf dist tsconfig.build.tsbuildinfo && npm run build`.
- BullMQ needs `maxRetriesPerRequest: null` on the Redis connection (`app.module.ts`) — do not "simplify" it.
- `TelegramModule` ↔ documents queue cycle is broken via `@Global() DocumentJobNotifierModule` + `DOCUMENT_JOB_NOTIFIER` port — never import TelegramModule from AppApiModule or vice versa directly.
- `pdf-parse` runs in a `piscina` worker pool constructed lazily via `getPdfParsePool()` — eager construction in a constructor crashes specs (missing compiled `.js` under ts-jest). Most specs `new TelegramService(...)` directly without `TestingModule`; keep that pattern working.
- Conversation history is a Redis list (`conv:{userId}`, RPUSH/Lua/LTRIM) — not a JSON blob. Docvault chunks are owner-scoped (`LawChunk.ownerUserId`); no resolvable owner ⇒ skip docvault search, never fall back to unscoped. Law chunks carry `roomId`.
- Device tokens are stored sha256-hashed only; reverse pairing: device proposes a DOK-###### code + secret (`POST /app/v1/auth/pair-propose`, first-writer-wins `app_pair_device:{code}`, TTL 60 s), the bot claims it (`claimDeviceCode`, atomic GETDEL), the device polls the claim (`POST /app/v1/auth/pair-status`, atomic compare-and-delete). `AppTasksService` is userId-scoped (`updateMany`/`deleteMany` + IDOR guard on `sourceDocumentId`).
- Re-running ingest after a parsing-only change does nothing until checksums reset: `UPDATE "Law" SET checksum = NULL …`, then `POST /admin/ingest[/:lawId]` with `x-admin-token`. Full reindex runs BGE-M3 locally and can be compute-heavy, but has no per-call embedding API cost.
- Rust `Transport`/`KeyProvider` must stay `Send + Sync` (`SyncClient` owns `Arc<dyn …>`) or Tauri `spawn_blocking` breaks. Tauri sync commands must be `async` + `spawn_blocking` — sync commands run on the main thread and freeze the webview. Never hash the ~5 GB model file in `model_status`; existence+size check only.

## Roles

- `REVIEWER:` correctness/edge cases/races; every DB/API/Redis call handled; N+1, missing transactions; no secrets in logs, raw SQL parameterized, no unscoped docvault/law queries. Output 🔴 BLOCKER / 🟡 WARNING / 🟢 SUGGESTION + verdict APPROVE / APPROVE WITH WARNINGS / REQUEST CHANGES.
- `TESTER:` jest + `@nestjs/testing`, mock externals (no real Anthropic/local retrieval/Telegram). Cover: null/undefined, boundaries, concurrent calls, Anthropic refusal/empty, local embedding/reranker failures or malformed responses, Telegram double-webhook, PDFs (0-page/corrupt/image-only/50 MB), memory duplicates/injection/special chars. Output ready-to-run spec, no placeholders.
- `SECURITY:` prompt injection into LLMs, PDF/zip bombs, GDPR (`forgetAll` must clear all user tables + Redis `conv:`/`lang:`/`letter_*` + BullMQ jobs), raw SQL, secrets in logs/errors, unthrottled costly endpoints, Telegram webhook spoofing. Output 🔴 CRITICAL / 🟡 MEDIUM / 🟢 LOW + exact fix.
