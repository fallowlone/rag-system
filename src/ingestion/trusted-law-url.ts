const TRUSTED_LAW_HOST = "www.gesetze-im-internet.de";

/** Identifies this crawler to the GII operators (they publish the XML for automated use). */
export const GII_USER_AGENT =
  "rag-system-law-crawler (+https://github.com/fallowlone/rag-system)";

/**
 * Gate between remote-supplied law URLs (GII TOC `<link>` values, DB rows)
 * and any network fetch. Returns an https-normalized URL when it points at
 * the trusted GII host, or null otherwise — callers must skip rather than
 * fetch on null. Confirmed live GII links use plain http://, so this also
 * closes an on-path MITM content-injection gap by forcing https.
 */
export function toTrustedLawUrl(rawUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }

  if (parsed.hostname !== TRUSTED_LAW_HOST) return null;
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  parsed.protocol = "https:";
  return parsed.toString();
}
