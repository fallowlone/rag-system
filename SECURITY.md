# Security policy

## Reporting a vulnerability

Please do **not** open a public issue for security problems.

Use GitHub's private vulnerability reporting: the **Security** tab of this
repository, then **Report a vulnerability**. Include what you found, how to
reproduce it, and the commit you tested.

This is a single-maintainer project. Expect an acknowledgement within a
few days; there is no formal SLA.

## Scope

In scope:

- The NestJS backend in `src/` (Telegram webhook handling, the
  `/app/v1/*` API, admin endpoints, ingestion).
- Prompt-injection paths where user or document content reaches an LLM.
- PDF and document parsing (path traversal, resource exhaustion).
- The macOS app in `apps/macos/`, including how it stores and sends data.
- Secrets or personal data leaking into logs or error messages.

Out of scope: findings that need a compromised host, denial of service by
sheer request volume, and vulnerabilities in third-party dependencies
(report those upstream).

## Not legal advice

This project answers legal questions with an LLM. Wrong or incomplete answers
are a known limitation, not a security vulnerability. See the disclaimer in
the [README](README.md).

## Supported versions

Only the latest commit on `main` is supported. The software is provided
"as is", without warranty; see the [Disclaimer](README.md#disclaimer) and the
[LICENSE](LICENSE).
