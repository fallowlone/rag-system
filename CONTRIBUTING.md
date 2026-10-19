# Contributing

Thanks for your interest. This is a small project; open an issue before
starting anything larger than a bug fix so we can agree on the approach.

## Setup

See the "Run it" section of the [README](README.md). Quick check that your
environment works:

```sh
npm ci
npx tsc --noEmit
npm run lint
npm test
```

## Rules for code changes

- TypeScript is strict. No `any`, and no `!` without a comment saying why.
- Use the NestJS `Logger`, not `console.log`.
- Catch and log errors; never swallow them.
- No business logic in controllers; put it in services.
- Modules export only what other modules need. Service interfaces live in
  `types.ts`.
- Prompts to Claude use XML format.
- Prefer batch operations over loops of individual API calls.
- Never edit an existing Prisma migration; add a new one
  (`npm run prisma:migrate:dev`).
- Never put personal data, API keys or real user documents in code, tests,
  fixtures or logs. Fixtures must be synthetic.

## Tests

- Jest with `@nestjs/testing`. Mock all external services (Anthropic,
  Telegram, the retrieval models service); tests must not call real APIs.
- Add tests for new behavior, including failure cases.
- If you change retrieval (chunking, filters, rerank, models), run
  `npm run eval:retrieval` before and after and include both results in the
  pull request. See [`eval/README.md`](eval/README.md).
- If you change macOS extraction, run `npm run eval:extraction` (and the
  model tier if you touch prompts). See
  [`eval/extraction/README.md`](eval/extraction/README.md).

## Pull requests

- Keep each PR focused on one change.
- Commit messages: `<type>: <description>` with type one of `feat`, `fix`,
  `refactor`, `docs`, `test`, `chore`, `perf`, `ci`.
- Describe what changed and how you tested it.

## Security issues

Do not file them as public issues. See [SECURITY.md](SECURITY.md).

## License

By contributing you agree that your contribution is licensed under the
Apache License 2.0, the same as the project.
