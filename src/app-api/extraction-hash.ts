import { createHash } from "crypto";
import { AppDocumentIngestInput } from "./app-api.types";

/**
 * Fingerprint of an extraction payload.
 *
 * `sourceHash` identifies the FILE. This identifies what the local model made
 * of it — so the ingest path can tell "the user pushed the same document
 * again" (idempotent, cheap) from "the user re-extracted it and the result
 * changed" (re-ingest). Without that distinction every improvement to
 * extraction — a better model, a changed prompt, a new backstop label — was
 * invisible for every document already stored, because the duplicate branch
 * only ever filled in gaps.
 *
 * Deliberately derived from the payload rather than from a client-supplied
 * version number: it needs no client change, and it captures every reason the
 * extraction might differ, including ones nobody thought to version.
 *
 * `sourceHash` is excluded because it is the key, not the content — including
 * it would be a constant within any comparison this hash is used for.
 */
export function extractionFingerprint(input: AppDocumentIngestInput): string {
  // Canonical, order-stable shape. Arrays keep their order: the model's
  // ordering is meaningful (facts and deadlines are emitted in document
  // order), so a reordering IS a different extraction.
  const canonical = JSON.stringify([
    input.fileName ?? null,
    input.title ?? null,
    input.sender ?? null,
    input.category,
    input.docDate ?? null,
    input.summary ?? null,
    input.facts.map((f) => [f.content, f.importance]),
    input.deadlines.map((d) => [d.label, d.date, d.kind ?? null]),
    input.obligations,
    input.addresses.map((a) => [a.purpose ?? null, a.address]),
    input.amounts.map((a) => [a.label ?? null, a.value, a.currency ?? null]),
    input.tags,
    input.isActive,
    input.expiryDate ?? null,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}
