/**
 * Deterministic detail backstop for the Telegram ingest path.
 *
 * The macOS app has had one since the extraction eval was built
 * (`ensure_key_details` in `dokumente-core`): reference numbers, contacts,
 * office hours and the letter date are recovered from the raw text by label,
 * so they do not depend on the model noticing them. Telegram had nothing —
 * the same Bescheid gave a weaker guarantee purely because of which entry
 * point the user chose, and Telegram is the primary one.
 *
 * This is a port, not a second design. `key-details.contract.spec.ts` drives
 * BOTH implementations from the shared fixtures in `eval/extraction/` and
 * fails when either one stops finding a detail the expectations mark
 * `deterministic`, so the two cannot drift apart silently.
 *
 * Values use restricted character sets on purpose: everything here comes out
 * of an attacker-influenceable document, and a bounded charset is what makes
 * a mechanical extraction safe to keep even when it describes hostile text.
 */

/** Ceiling on added facts — a runaway document must not bury the model's output. */
const MAX_ADDED = 12;

/** Mirror of `MAX_PROMPT_DOC_CHARS` in dokumente-core. */
export const MAX_PROMPT_DOC_CHARS = 24_000;

const REFERENCE_LABELS = [
  "bg-nummer",
  "aktenzeichen",
  "geschäftszeichen",
  "kundennummer",
  "versicherungsnummer",
  "versichertennummer",
  "vertragsnummer",
  "policennummer",
  "steuernummer",
];

const PHONE_LABELS = ["telefon", "tel.", "tel:", "rufnummer", "fax"];

const HOURS_LABELS = [
  "sprechzeiten",
  "sprechzeit",
  "bürozeiten",
  "öffnungszeiten",
  "geschäftszeiten",
  "servicezeiten",
];

const ROOM_LABELS = ["zimmer", "raum"];
const PLATE_LABELS = ["kennzeichen", "kfz-kennzeichen"];
const AREA_LABELS = ["wohnfläche", "nutzfläche", "grundfläche"];
const START_LABELS = [
  "mietbeginn",
  "vertragsbeginn",
  "versicherungsbeginn",
  "beginnt am",
  "beginn am",
];

function isAlnum(ch: string | undefined): boolean {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every occurrence of `label`, case-insensitively, returning the text that
 * follows each one. Matching runs through a case-insensitive RegExp rather
 * than a lowercased copy: `"İ".toLowerCase()` is two code units in
 * JavaScript, so indices taken from a folded copy point at the wrong place
 * in the original — the same hazard the Rust side documents.
 */
function afterEachLabel(raw: string, label: string): string[] {
  const re = new RegExp(escapeRegex(label), "giu");
  const out: string[] = [];
  for (const match of raw.matchAll(re)) {
    const start = match.index;
    const end = start + match[0].length;
    // Word boundaries: "tel" must not match inside "teile".
    if (isAlnum(raw[start - 1]) || isAlnum(raw[end])) continue;
    out.push(raw.slice(end));
  }
  return out;
}

function stripLeadingSep(text: string): string {
  return text.replace(/^[:\s\t\-–]+/u, "");
}

function stripLeadingSepSameLine(text: string): string {
  return text.replace(/^[: \t\-–]+/u, "");
}

function stripTrailingPunct(text: string): string {
  return text.replace(/[.,;: \t)]+$/u, "");
}

/** Cuts at the first sentence boundary so a capture stops at the line's own end. */
function cutSentence(text: string): string {
  const match = /[.?!](\s|$)/u.exec(text);
  return (match ? text.slice(0, match.index) : text).trim();
}

function takeWhile(text: string, allowed: (ch: string) => boolean): string {
  let out = "";
  for (const ch of text) {
    if (!allowed(ch)) break;
    out += ch;
  }
  return out;
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * Reads a German licence plate at the start of `text`: 1-3 letters, hyphen,
 * 1-2 letters, separator, 1-4 digits, optional E/H suffix. Matched by SHAPE
 * because the plate is normally followed by prose on the same line, where a
 * character run either swallows the sentence or stops arbitrarily.
 */
export function readPlate(text: string): string | null {
  const match = /^(\p{L}{1,3})-(\p{L}{1,2})( ?)(\d{1,4})([EeHh]?)(?![\p{L}\p{N}])/u.exec(text);
  if (!match) return null;
  const [, , letters, space] = match;
  // Without a separator a single-letter group is ambiguous against ordinary
  // tokens ("B-A4711"), so require the space unless both letters are present.
  if (space === "" && letters.length < 2) return null;
  return match[0];
}

/**
 * E-mail addresses, found by scanning for `@` rather than by label: the
 * address is self-identifying while the phrases introducing one are not
 * enumerable ("Per E-Mail erreichen Sie uns unter …").
 */
export function findEmails(raw: string): string[] {
  const re = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
  const out: string[] = [];
  for (const match of raw.matchAll(re)) {
    const address = match[0].replace(/\.+$/u, "");
    const local = address.slice(0, address.indexOf("@"));
    if (local.startsWith(".") || local.endsWith(".")) continue;
    if (!out.includes(address)) out.push(address);
  }
  return out;
}

/**
 * The letter date from the German Briefkopf convention ("Berlin, den
 * 12.09.2026"). First occurrence wins: the letter date heads the document
 * and every later date is a deadline.
 */
export function findLetterDate(raw: string): string | null {
  for (const after of afterEachLabel(raw, "den")) {
    const value = takeWhile(stripLeadingSepSameLine(after), (c) => /[\d.]/u.test(c));
    const trimmed = value.replace(/\.+$/u, "");
    const parts = trimmed.split(".");
    if (parts.length !== 3) continue;
    const [day, month, year] = parts.map((p) => Number(p));
    if (!day || !month || year < 1000) continue;
    if (day > 31 || month > 12) continue;
    return trimmed;
  }
  return null;
}

/** German IBAN (DE + 20 digits, single spaces allowed) → fixed mask. */
export function maskIbans(text: string): string {
  return text.replace(
    /\bDE(?:[ ]?\d){20}(?!\d)/giu,
    "IBAN (maskiert)",
  );
}

/**
 * Mechanically recovers key details from the raw document text.
 *
 * `known` is everything the model already produced — a detail it found is
 * never repeated. Returns German fact strings in the same shapes the macOS
 * client emits, so a document ingested through either entry point reads the
 * same way.
 */
export function extractKeyDetails(rawText: string, known: string[] = []): string[] {
  const added: string[] = [];
  const knownLower = known.join("\n").toLowerCase();
  const knownNoSpace = knownLower.replace(/\s+/gu, "");
  let addedLower = "";
  let addedNoSpace = "";

  const push = (content: string): void => {
    if (added.length >= MAX_ADDED) return;
    added.push(content);
    addedLower += `${content.toLowerCase()}\n`;
    addedNoSpace += content.toLowerCase().replace(/\s+/gu, "");
  };

  const seen = (value: string): boolean => {
    const lower = value.toLowerCase();
    return knownLower.includes(lower) || addedLower.includes(lower);
  };

  // Reference numbers.
  for (const label of REFERENCE_LABELS) {
    for (const after of afterEachLabel(rawText, label)) {
      const value = stripTrailingPunct(
        takeWhile(stripLeadingSepSameLine(after), (c) =>
          /[\p{L}\p{N} ./-]/u.test(c),
        ),
      ).trim();
      if (value.length < 3 || value.length > 24) continue;
      if (!/\d/u.test(value) || seen(value)) continue;
      const pretty = label
        .split("-")
        .map((w) => (w.length <= 2 ? w.toUpperCase() : capitalize(w)))
        .join("-");
      push(`Referenznummer (${pretty}): ${value}.`);
    }
  }

  // Contact phone numbers, compared digits-only: the model may write
  // "030 55578912" where the document has "030/55578912".
  for (const label of PHONE_LABELS) {
    for (const after of afterEachLabel(rawText, label)) {
      const run = takeWhile(stripLeadingSepSameLine(after), (c) =>
        /[\d ()./+-]/u.test(c),
      );
      const digits = run.replace(/\D/gu, "");
      if (digits.length < 6) continue;
      if (knownNoSpace.includes(digits) || addedNoSpace.includes(digits)) continue;
      const prettyLabel =
        label.replace(/[.:]$/u, "") === "tel"
          ? "Telefon"
          : capitalize(label.replace(/[.:]$/u, ""));
      push(`Kontakt (${prettyLabel}): ${stripTrailingPunct(run.trim())}.`);
    }
  }

  // Office hours — the document's own word is kept, never relabelled.
  for (const label of HOURS_LABELS) {
    for (const after of afterEachLabel(rawText, label)) {
      const firstLine = stripLeadingSepSameLine(after).split("\n")[0] ?? "";
      const value = stripTrailingPunct(cutSentence(firstLine)).trim();
      if (value.length < 3 || value.length > 100 || seen(value)) continue;
      push(`${capitalize(label)}: ${value}.`);
    }
  }

  // Vehicle registration — the value often sits on the line below the label.
  for (const label of PLATE_LABELS) {
    for (const after of afterEachLabel(rawText, label)) {
      const value = readPlate(stripLeadingSep(after));
      if (!value || seen(value)) continue;
      push(`Kennzeichen: ${value}.`);
    }
  }

  // Floor area — prose, never "Label: value". Deliberately no cutSentence:
  // the German abbreviation "ca." is a sentence boundary by that rule and
  // would truncate the value to "ca".
  for (const label of AREA_LABELS) {
    for (const after of afterEachLabel(rawText, label)) {
      const rest = stripLeadingSepSameLine(after).replace(/^von /u, "");
      const value = stripTrailingPunct(rest.split("\n")[0] ?? "").trim();
      if (value.length < 2 || value.length > 40) continue;
      if (!/\d/u.test(value) || seen(value)) continue;
      push(`${capitalize(label)}: ${value}.`);
    }
  }

  // Contract start dates — "Das Mietverhältnis beginnt am 01.11.2026" carries
  // no label at all.
  for (const label of START_LABELS) {
    for (const after of afterEachLabel(rawText, label)) {
      const run = takeWhile(stripLeadingSepSameLine(after), (c) => /[\d.]/u.test(c));
      // The sentence's full stop rides along when the date ends it.
      const value = run.replace(/\.+$/u, "");
      if ((value.match(/\./gu) ?? []).length !== 2) continue;
      if (value.length < 8 || value.length > 10 || seen(value)) continue;
      const pretty = label.startsWith("beginn") ? "Vertragsbeginn" : capitalize(label);
      push(`${pretty}: ${value}.`);
    }
  }

  // Room numbers.
  for (const label of ROOM_LABELS) {
    for (const after of afterEachLabel(rawText, label)) {
      const value = takeWhile(stripLeadingSepSameLine(after), (c) =>
        /[\p{L}\p{N}.-]/u.test(c),
      );
      if (value.length < 2 || value.length > 12 || seen(value)) continue;
      push(`Zimmer: ${value}.`);
    }
  }

  // E-mail.
  for (const address of findEmails(rawText)) {
    if (seen(address)) continue;
    push(`Kontakt (E-Mail): ${address}.`);
  }

  // Letter date.
  const letterDate = findLetterDate(rawText);
  if (letterDate && !seen(letterDate)) {
    push(`Briefdatum: ${letterDate}.`);
  }

  // IBANs that slipped in despite the prompt ban are masked here too — the
  // account reference stays readable, the payload never reaches the store.
  return added.map((fact) => maskIbans(fact));
}
