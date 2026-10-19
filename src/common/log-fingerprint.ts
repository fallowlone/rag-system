import { createHash } from "node:crypto";

/**
 * One-way fingerprint for user-supplied text in logs: length for support
 * correlation plus a sha256 prefix for repeat/abuse detection. Raw user
 * text (questions, search queries, captions) must never reach logs — log
 * files get pasted into tickets and retained far longer than chat history.
 */
export function fingerprint(text: string): string {
  const digest = createHash("sha256")
    .update(text, "utf8")
    .digest("hex")
    .slice(0, 12);
  return `len=${text.length} sha=${digest}`;
}
