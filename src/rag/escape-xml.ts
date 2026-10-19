/**
 * XML-escapes values interpolated into LLM prompts. Retrieval content,
 * memories, diary entries and user questions are untrusted (a literal
 * `</question>` or `[LETTER_STYLE_CHOICE]`-like string inside a compromised
 * document would otherwise break out of its tag and become instructions).
 * Attribute values are covered too (quotes escaped).
 */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
