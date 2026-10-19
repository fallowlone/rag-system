import { Prisma } from "@prisma/client";

/**
 * SQL fragment matching every LawChunk normKey that belongs to `docvaultId`.
 * `chunkNormText` always emits `${baseNormKey}_pN_cM`, so the LIKE prefix
 * covers all of a document's chunks and a bare-id normKey never exists.
 * `_` and `%` inside the docvaultId itself are escaped, so an id that is a
 * prefix of another id (doc-9 vs doc-90…) can never match the other id's
 * chunks.
 */
export function docvaultNormKeyFilter(docvaultId: string): Prisma.Sql {
  const escapedPrefix =
    docvaultId.replace(/[_%]/g, "\\$&") + "\\_%";
  return Prisma.sql`("normKey" LIKE ${escapedPrefix})`;
}

/** Trailing `_pN_cM` that `chunkNormText` appends to every chunk it emits. */
const DOCVAULT_CHUNK_SUFFIX = /_p\d+_c\d+$/;

/**
 * Inverse of `docvaultNormKeyFilter`: recovers the docvaultId (UserDocument.id)
 * a chunk belongs to from its normKey.
 *
 * Returns null rather than guessing when the key does not carry the suffix, or
 * carries nothing before it — a malformed key read as a document id would pull
 * the wrong document's summary into the prompt, and every caller is expected to
 * scope its own query by userId anyway.
 */
export function docvaultIdFromNormKey(normKey: string): string | null {
  const match = DOCVAULT_CHUNK_SUFFIX.exec(normKey);
  if (!match || match.index === 0) return null;
  return normKey.slice(0, match.index);
}
