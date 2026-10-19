/**
 * Single source of truth for the Anthropic model identifiers. Every
 * per-purpose `*_MODEL` const across the codebase aliases one of these, so
 * a model swap is a one-line change here instead of a 17-site edit.
 * (Follows the `src/llm-usage.ts` precedent — a tiny dependency-free module
 * any service can import without DI cycles.)
 */

/**
 * Cheap classifier / rewrite / extraction model (Haiku).
 *
 * Canonical id, not a dated snapshot: `claude-haiku-4-5` is complete as-is and
 * is what the platform documents. The pinned `-20251001` snapshot resolved to
 * the same weights but silently opts out of in-place fixes to the alias.
 */
export const HAIKU_MODEL = "claude-haiku-4-5";

/** Answer-quality model (Sonnet) — once per real answer, never per message. */
export const SONNET_MODEL = "claude-sonnet-5";
