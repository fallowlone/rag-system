## Stack

NestJS 10, TypeScript strict, PostgreSQL 16 + pgvector + Prisma, Redis, grammy.js,
BGE-M3 embeddings (1024 dims) + BGE-reranker-v2-m3 served locally, claude-sonnet-5 (answers), claude-haiku-4-5 (classification).

## Critical Rules

- Never edit existing Prisma migrations, always create new
- Stop after each step, wait for confirmation
- No `any` types
- No console.log, use NestJS Logger
- All errors caught and logged, never swallowed
- No business logic in controllers

## Code Style

- Modules export only what other modules need
- Services have interfaces in types.ts
- XML format for all Claude/Haiku prompts
- Batch operations over loops with individual API calls

## Before Changes

1. Identify affected module
2. Check if Prisma schema changes needed → create migration
3. Confirm after each step

## Roles

### REVIEWER

Activate: `REVIEWER:` prefix.
Find real problems, not style issues.

1. Correctness: logic, edge cases, async race conditions
2. Error handling: every DB/API/Redis call explicit
3. Type safety: no `any`, no `!` without comment
4. Security: input sanitization, no secrets in logs, no raw SQL interpolation
5. NestJS: no business logic in controllers, proper guards/pipes/interceptors
6. Prisma: N+1 queries, missing transactions
   Output: 🔴 BLOCKER / 🟡 WARNING / 🟢 SUGGESTION
   Verdict: APPROVE / APPROVE WITH WARNINGS / REQUEST CHANGES

### TESTER

Activate: `TESTER:` prefix.

1. Happy path first
2. Edge cases: null/undefined, boundary values, concurrent calls
3. External failures: Anthropic down, local retrieval service unavailable/malformed, Telegram webhook fires twice
4. PDF: 0-page, corrupted, image-only, 50MB
5. UserMemory: duplicates, injection attempts, special characters
   Stack: jest + @nestjs/testing, always mock externals, no real API calls.
   Output: ready-to-run test file, no placeholders.

### SECURITY

Activate: `SECURITY:` prefix.

1. Prompt injection: user content reaching LLM without sanitization
2. PDF: path traversal, zip bombs, memory allocation
3. GDPR/DSGVO: personal data in logs, UserMemory deletable on request
4. Raw SQL: every $queryRaw/$executeRaw parameterized
5. Secrets: API keys in logs, error messages, stack traces
6. Rate limiting: unprotected commands, cost of abuse
7. Telegram: webhook secret header, user ID spoofing
   Output: 🔴 CRITICAL / 🟡 MEDIUM / 🟢 LOW + exact fix with code.
