//! Local LLM extraction (Phase 3 wires llama.cpp; this module owns the
//! contract: the German extraction prompt and the JSON types).
//! Constrained decoding uses the JSON Schema transcribed in runner.rs
//! (mirrors the backend Zod validation) — the model physically cannot emit
//! JSON that the server would reject on shape grounds.

use crate::error::{CoreError, Result};
use crate::types::{Amount, Category, Extraction, Fact, Importance};

pub mod model_manager;
mod model_manager_tests;

#[cfg(feature = "llama")]
pub mod runner;

/// Maximum chars of document text fed to the local model in the prompt.
/// Keeps a single inference bounded even for pathologically long documents
/// (the store keeps the full text; only the prompt is truncated).
pub const MAX_PROMPT_DOC_CHARS: usize = 24_000;

/// The German extraction prompt. The privacy filter is explicit: decision-
/// relevant facts are kept, irrelevant PII (IDs, birthdates, account
/// numbers) is dropped — see the spec's privacy model.
pub const EXTRACTION_SYSTEM_PROMPT: &str = r#"Du bist ein Assistent, der deutsche Behörden- und Vertragsdokumente analysiert.

<task>
Extrahiere aus dem Dokument die entscheidungsrelevanten Informationen als JSON.
Das Dokument verlässt niemals dieses Gerät.
</task>

<relevanz>
Speichern: Fristen, Beträge, Vertragsbedingungen, Adressen von Institutionen
(Absender, zuständige Stelle), Verpflichtungen des Nutzers, Vertragslaufzeiten,
Kündigungsbedingungen, Anspruchsgrundlagen, Referenznummern (Aktenzeichen,
BG-Nummer), Kontaktdaten von Ansprechpartnern (Telefon, Sprechzeiten, Zimmer).
NICHT speichern: Ausweisnummern, Geburtsdaten, Kontonummern, IBAN, Unterschriften,
Krankenkassennummern und andere reine Identifikationsdaten ohne Entscheidungswert.
IBANs/Kontonummern nie in facts übernehmen, auch nicht als Teil eines Satzes.
Maschinell-Floskeln ("ohne Unterschrift gültig") sind kein Fakt.
</relevanz>

<regeln>
- category: genau einer aus mietvertrag | jobcenter | bank | visa | versicherung | other
- facts: prägnante deutsche Aussagesätze (keine Zitate des Originaltexts)
- deadlines: nur Termine, die für den Nutzer relevant sind; date als YYYY-MM-DD
- obligations: was der Nutzer aktiv tun muss (z.B. "Nachweise beim Jobcenter einreichen")
- summary: 1-2 Sätze zum Inhalt; docDate: Briefdatum als YYYY-MM-DD
- amounts und addresses zusätzlich strukturiert befüllen, nicht nur im Fließtext
- tags: kurze Schlagwörter ohne Duplikate
- is_active: false bei abgelaufenen oder erledigten Dokumenten
- Lasse leere Listen einfach leer, statt Platzhalter zu erfinden
</regeln>

<output>
Nur das JSON-Objekt gemäß dem vorgegebenen Schema, kein weiterer Text.
</output>"#;

/// Builds the user message for the extraction prompt: the sha256 (which the
/// model must copy verbatim into source_hash — the grammar forces the hex
/// shape, the prompt forces the value) followed by the document text,
/// truncated to MAX_PROMPT_DOC_CHARS.
pub fn build_user_prompt(source_hash: &str, raw_text: &str) -> String {
    let truncated: String = raw_text.chars().take(MAX_PROMPT_DOC_CHARS).collect();
    let suffix = if raw_text.chars().count() > MAX_PROMPT_DOC_CHARS {
        "\n[Dokument gekürzt]"
    } else {
        ""
    };
    format!(
        "sourceHash (unverändert übernehmen): {source_hash}\n\n<dokument>\n{truncated}{suffix}\n</dokument>"
    )
}

/// Deterministic backstop for the small actionable details the local model
/// drops unpredictably (measured: BG-Nummer in 0/4 eval runs, Berater phone
/// in 1/4, docDate/summary/addresses often empty): label-anchored scans over
/// the raw text for case references, contact channels, office hours and room
/// numbers. Only ADDS facts whose value appears nowhere in the model's
/// output yet (facts, summary, addresses, deadline labels) — never duplicates
/// what the model already captured, never touches PII-shaped data without a
/// label (bare IBANs, birthdates and amounts are intentionally out of scope).
/// Capped so a pathological document cannot spam the fact list.
pub fn ensure_key_details(raw_text: &str, extraction: &mut Extraction) {
    /// Ceiling on deterministically added facts — a runaway document must not
    /// bury the model's output under boilerplate. Raised from 6 when the
    /// label set grew: `versicherung-kfz.txt` alone yields seven
    /// (Kundennummer, Telefon, Sprechzeiten, Zimmer, Versicherungsnummer,
    /// Kennzeichen, E-Mail), and a cap below what one ordinary letter
    /// produces drops real details silently, in label order.
    const MAX_ADDED: usize = 12;

    /// Lowercased haystack of everything the model already produced, for
    /// dedup checks.
    fn known_text(extraction: &Extraction) -> String {
        let mut out = String::new();
        for f in &extraction.facts {
            out.push_str(&f.content);
            out.push('\n');
        }
        if let Some(summary) = &extraction.summary {
            out.push_str(summary);
            out.push('\n');
        }
        for a in &extraction.addresses {
            if let Some(purpose) = &a.purpose {
                out.push_str(purpose);
                out.push('\n');
            }
            out.push_str(&a.address);
            out.push('\n');
        }
        for d in &extraction.deadlines {
            out.push_str(&d.label);
            out.push('\n');
        }
        out.to_lowercase()
    }

    /// Finds every occurrence of `label` (case-insensitive) and returns the
    /// text right after each one with leading separators stripped.
    /// Indices always refer to `raw`: searching a lowercased copy would
    /// shift byte offsets after length-changing case folds (ẞ→ss, İ→i̇),
    /// so slices taken with those indices can panic (not a char boundary)
    /// or read the wrong text — and the extractor thread has no
    /// catch_unwind, so one panic kills all later extractions until restart.
    fn after_each_label<'a>(raw: &'a str, label: &str) -> Vec<&'a str> {
        let mut out = Vec::new();
        let mut search_from = 0;
        while let Some((match_at, end)) = find_folded(raw, label, search_from) {
            let start = end;
            search_from = start;
            // Word-boundary guard: "tel" must not match "teile", "raum" must
            // not match "trauma". is_alphanumeric is case-invariant, so the
            // raw char can be tested directly — no lowercased copy needed.
            let before_ok = match_at == 0
                || !raw[..match_at]
                    .chars()
                    .next_back()
                    .is_some_and(|c| c.is_alphanumeric());
            let after_ok = raw[start..]
                .chars()
                .next()
                .is_none_or(|c| !c.is_alphanumeric());
            if before_ok && after_ok {
                out.push(&raw[start..]);
            }
        }
        out
    }

    fn strip_leading_sep(s: &str) -> &str {
        s.trim_start_matches([':', ' ', '\t', '-', '–'])
    }

    /// Same, but crosses line breaks: German letters routinely put the value
    /// on the line below its label ("… amtlichen Kennzeichen\nB-AM 4711").
    fn strip_leading_sep_multiline(s: &str) -> &str {
        s.trim_start_matches([':', ' ', '\t', '-', '–', '\n', '\r'])
    }

    /// Capitalises a label for display: "bürozeiten" → "Bürozeiten".
    fn pretty_word(label: &str) -> String {
        let mut chars = label.chars();
        match chars.next() {
            Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
            None => String::new(),
        }
    }

    fn strip_trailing_punct(s: &str) -> &str {
        s.trim_end_matches(['.', ',', ';', ':', ' ', '\t', ')'])
    }

    /// Cuts free text at the first sentence boundary so rest-of-line captures
    /// ("Sprechzeiten Di 9-12. Bei Fragen …") don't swallow the next sentence.
    fn cut_sentence(s: &str) -> &str {
        let mut end = s.len();
        for (i, _) in s.char_indices() {
            let rest = &s[i..];
            if (rest.starts_with(". ") || rest.starts_with("? ") || rest.starts_with("! "))
                || ((rest.starts_with('.') || rest.starts_with('?') || rest.starts_with('!'))
                    && s[i + 1..].trim_start().is_empty())
            {
                end = i;
                break;
            }
        }
        s[..end].trim()
    }

    let known = known_text(extraction);
    let mut added = 0;
    // Extended with every value we add: repeated occurrences of the same
    // label (letterhead + body) must not produce duplicate facts.
    // `known_extra` travels as a parameter (not a capture) so the
    // read-checks below can borrow it between pushes.
    let mut known_extra = String::new();
    let mut known_extra_nospace = String::new();
    let mut push_fact = |content: String,
                         extraction: &mut Extraction,
                         known_extra: &mut String,
                         known_extra_nospace: &mut String| {
        if added >= MAX_ADDED {
            return;
        }
        added += 1;
        known_extra.push_str(&content.to_lowercase());
        known_extra.push('\n');
        known_extra_nospace.push_str(
            &content
                .to_lowercase()
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect::<String>(),
        );
        extraction.facts.push(Fact {
            content,
            importance: Importance::Medium,
        });
    };
    // Case / file references: BG-Nummer, Aktenzeichen, Geschäftszeichen.
    for label in [
        "bg-nummer",
        "aktenzeichen",
        "geschäftszeichen",
        "kundennummer",
        // Same shape, same value to the user, previously model-tier only:
        // measured 0/5 every run on versicherung-kfz before this line.
        "versicherungsnummer",
        "versichertennummer",
        "vertragsnummer",
        "policennummer",
        "steuernummer",
    ] {
        for after in after_each_label(raw_text, label) {
            let value: String = strip_trailing_punct(strip_leading_sep(after))
                .chars()
                .take_while(|c| {
                    c.is_alphanumeric() || *c == ' ' || *c == '.' || *c == '/' || *c == '-'
                })
                .collect();
            let value = value.trim().to_string();
            let has_digit = value.chars().any(|c| c.is_ascii_digit());
            let value_lower = value.to_lowercase();
            if value.chars().count() < 3
                || value.chars().count() > 24
                || !has_digit
                || known.contains(&value_lower)
                || known_extra.contains(&value_lower)
            {
                continue;
            }
            let pretty = label
                .split('-')
                .map(|w| {
                    if w.len() <= 2 {
                        // Initialisms stay uppercase: bg-nummer → BG-Nummer.
                        return w.to_uppercase();
                    }
                    let mut chars = w.chars();
                    match chars.next() {
                        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                        None => String::new(),
                    }
                })
                .collect::<Vec<_>>()
                .join("-");
            push_fact(
                format!("Referenznummer ({pretty}): {value}."),
                extraction,
                &mut known_extra,
                &mut known_extra_nospace,
            );
        }
    }

    // Contact channels: Telefon, Rufnummer, Fax.
    // Whitespace-insensitive known text: the model may write "030 55578912"
    // while the digits-only comparison needs "03055578912".
    let known_nospace: String = known.chars().filter(|c| !c.is_whitespace()).collect();
    for label in ["telefon", "tel.", "tel:", "rufnummer", "fax"] {
        for after in after_each_label(raw_text, label) {
            let run: String = strip_leading_sep(after)
                .chars()
                .take_while(|c| {
                    c.is_ascii_digit()
                        || *c == ' '
                        || *c == '/'
                        || *c == '('
                        || *c == ')'
                        || *c == '.'
                        || *c == '-'
                        || *c == '+'
                })
                .collect();
            let digits: String = run.chars().filter(|c| c.is_ascii_digit()).collect();
            if digits.len() < 6
                || known_nospace.contains(&digits)
                || known_extra_nospace.contains(&digits)
            {
                continue;
            }
            let pretty = run.trim().trim_end_matches(['.', ',', ';', ':']);
            let pretty_label = label.trim_end_matches(['.', ':']);
            let pretty_label = match pretty_label {
                "tel" => "Telefon".to_string(),
                other => {
                    let mut chars = other.chars();
                    match chars.next() {
                        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                        None => String::new(),
                    }
                }
            };
            push_fact(
                format!("Kontakt ({pretty_label}): {pretty}."),
                extraction,
                &mut known_extra,
                &mut known_extra_nospace,
            );
        }
    }

    // Office hours: first line after the label, cut at the first sentence
    // boundary (the line often continues with the next sentence).
    // The anchor used to be "Sprechzeiten" only, so the same
    // sentence written "Bürozeiten …" — the normal word for a company rather
    // than an authority — fell through to the model, which missed it 0/5.
    for label in [
        "sprechzeiten",
        "sprechzeit",
        "bürozeiten",
        "öffnungszeiten",
        "geschäftszeiten",
        "servicezeiten",
    ] {
        for after in after_each_label(raw_text, label) {
            let first_line = strip_leading_sep(after).lines().next().unwrap_or("");
            let value = strip_trailing_punct(cut_sentence(first_line))
                .trim()
                .to_string();
            let value_lower = value.to_lowercase();
            if value.chars().count() < 3
                || value.chars().count() > 100
                || known.contains(&value_lower)
                || known_extra.contains(&value_lower)
            {
                continue;
            }
            // Keep the document's own word: relabelling Bürozeiten as
            // Sprechzeiten would misreport what the letter actually said.
            push_fact(
                format!("{}: {value}.", pretty_word(label)),
                extraction,
                &mut known_extra,
                &mut known_extra_nospace,
            );
        }
    }

    // Vehicle registration. The value routinely sits on the line BELOW its
    // label ("… mit dem amtlichen Kennzeichen\nB-AM 4711"), which every
    // same-line reader above would have read as empty.
    for label in ["kennzeichen", "kfz-kennzeichen"] {
        for after in after_each_label(raw_text, label) {
            // Matched by SHAPE, not by taking a run of characters: the plate
            // is usually followed by prose on the same line ("B-AM 4711 läuft
            // vom 01.01.2026 …"), so a character run either swallows the
            // sentence or gets cut at an arbitrary punctuation mark.
            let Some(value) = read_plate(strip_leading_sep_multiline(after)) else {
                continue;
            };
            let value_lower = value.to_lowercase();
            if known.contains(&value_lower) || known_extra.contains(&value_lower) {
                continue;
            }
            push_fact(
                format!("Kennzeichen: {value}."),
                extraction,
                &mut known_extra,
                &mut known_extra_nospace,
            );
        }
    }

    // Floor area. Written as prose ("mit einer Wohnfläche von ca. 68 qm"),
    // never as "Label: value" — note this deliberately does NOT use
    // `cut_sentence`, because the German abbreviation "ca." is itself a
    // sentence boundary by that rule and would truncate the value to "ca".
    for label in ["wohnfläche", "nutzfläche", "grundfläche"] {
        for after in after_each_label(raw_text, label) {
            let rest = strip_leading_sep(after);
            let rest = rest.strip_prefix("von ").unwrap_or(rest);
            let first_line = rest.lines().next().unwrap_or("");
            let value = strip_trailing_punct(first_line).trim().to_string();
            let value_lower = value.to_lowercase();
            if value.chars().count() < 2
                || value.chars().count() > 40
                || !value.chars().any(|c| c.is_ascii_digit())
                || known.contains(&value_lower)
                || known_extra.contains(&value_lower)
            {
                continue;
            }
            push_fact(
                format!("{}: {value}.", pretty_word(label)),
                extraction,
                &mut known_extra,
                &mut known_extra_nospace,
            );
        }
    }

    // Contract start dates. "Das Mietverhältnis beginnt am 01.11.2026" is the
    // standard phrasing and carries no label at all, so the date was only
    // ever found if the model chose to report it (0/5 on mietvertrag).
    for label in [
        "mietbeginn",
        "vertragsbeginn",
        "versicherungsbeginn",
        "beginnt am",
        "beginn am",
    ] {
        for after in after_each_label(raw_text, label) {
            let run: String = strip_leading_sep(after)
                .chars()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect();
            // The sentence's full stop rides along when the date ends it
            // ("… beginnt am 01.11.2026.") — strip it before the shape check,
            // or every date at the end of a sentence is silently rejected.
            let value = run.trim_end_matches('.').to_string();
            // DD.MM.YYYY or D.M.YYYY — exactly two dots, nothing else.
            if value.matches('.').count() != 2
                || value.chars().count() < 8
                || value.chars().count() > 10
            {
                continue;
            }
            if known.contains(&value) || known_extra.contains(&value) {
                continue;
            }
            let pretty = if label.starts_with("beginn") {
                "Vertragsbeginn".to_string()
            } else {
                pretty_word(label)
            };
            push_fact(
                format!("{pretty}: {value}."),
                extraction,
                &mut known_extra,
                &mut known_extra_nospace,
            );
        }
    }

    // Contact e-mail. Anchored on the address itself rather than on a label,
    // because German letters introduce it a dozen different ways ("Per
    // E-Mail erreichen Sie uns unter …") and the address is unambiguous on
    // its own.
    for address in find_emails(raw_text) {
        let lower = address.to_lowercase();
        if known.contains(&lower) || known_extra.contains(&lower) {
            continue;
        }
        push_fact(
            format!("Kontakt (E-Mail): {address}."),
            extraction,
            &mut known_extra,
            &mut known_extra_nospace,
        );
    }

    // Room numbers: Zimmer / Raum + short code.
    for label in ["zimmer", "raum"] {
        for after in after_each_label(raw_text, label) {
            let value: String = strip_trailing_punct(strip_leading_sep(after))
                .chars()
                .take_while(|c| c.is_alphanumeric() || *c == '.' || *c == '-')
                .collect();
            let value_lower = value.to_lowercase();
            if value.chars().count() < 2
                || value.chars().count() > 12
                || known.contains(&value_lower)
                || known_extra.contains(&value_lower)
            {
                continue;
            }
            push_fact(
                format!("Zimmer: {value}."),
                extraction,
                &mut known_extra,
                &mut known_extra_nospace,
            );
        }
    }

    // Letter date ("Berlin, den 12.09.2026" Briefkopf convention): the model
    // leaves docDate empty in most runs, but the backend indexes and displays
    // it — fill it deterministically when absent. First occurrence wins (the
    // letter date heads the document; later dates are deadlines).
    if extraction.doc_date.is_none() {
        if let Some(iso) = find_letter_date(raw_text) {
            extraction.doc_date = Some(crate::types::IsoDate(iso));
        }
    }

    // IBANs that slipped into facts despite the prompt ban: mask them
    // deterministically (German IBAN = DE + 20 digits, spaces optional).
    // The account reference stays readable as context, the sensitive payload
    // never reaches the server-side fact store.
    for fact in &mut extraction.facts {
        fact.content = mask_ibans(&fact.content);
    }
}

/// Reads a German licence plate at the START of `s`, or None.
///
/// Shape: 1-3 letters, hyphen, 1-2 letters, separator, 1-4 digits, with an
/// optional E (electric) or H (historic) suffix — e.g. `B-AM 4711`,
/// `M-XY 12E`. Matching the shape rather than scanning a character run is
/// what lets the plate be read out of the middle of a sentence. Pure —
/// unit-tested.
fn read_plate(s: &str) -> Option<String> {
    let chars: Vec<char> = s.chars().take(16).collect();
    let mut i = 0;

    let district_start = i;
    while i < chars.len() && chars[i].is_alphabetic() && i - district_start < 3 {
        i += 1;
    }
    let district_len = i - district_start;
    if district_len == 0 || i >= chars.len() || chars[i] != '-' {
        return None;
    }
    i += 1;

    let letters_start = i;
    while i < chars.len() && chars[i].is_alphabetic() && i - letters_start < 2 {
        i += 1;
    }
    if i == letters_start {
        return None;
    }
    let letters_len = i - letters_start;

    // Separator between the letter group and the number is a space in print
    // and sometimes absent in plain text.
    let mut had_space = false;
    while i < chars.len() && chars[i] == ' ' {
        had_space = true;
        i += 1;
    }
    let digits_start = i;
    while i < chars.len() && chars[i].is_ascii_digit() && i - digits_start < 4 {
        i += 1;
    }
    let digits_len = i - digits_start;
    if digits_len == 0 {
        return None;
    }
    // Without a separator, "AB-CD12" is ambiguous against ordinary tokens —
    // require the space unless the letter group is the full two characters.
    if !had_space && letters_len < 2 {
        return None;
    }

    // Optional E/H suffix, but nothing else may run on directly: a longer
    // alphanumeric tail means this was a reference number, not a plate.
    if i < chars.len() && matches!(chars[i], 'E' | 'e' | 'H' | 'h') {
        i += 1;
    }
    if i < chars.len() && chars[i].is_alphanumeric() {
        return None;
    }

    Some(chars[..i].iter().collect())
}

/// Extracts e-mail addresses by scanning for `@` and expanding outward over
/// the characters an address may contain. Deliberately not label-anchored:
/// the address is self-identifying, while the phrases that introduce one are
/// not enumerable. Pure — unit-tested.
///
/// Conservative on purpose: a domain must carry a dot and an alphabetic TLD
/// of at least two characters, so "@" used as shorthand in prose is skipped.
fn find_emails(raw_text: &str) -> Vec<String> {
    fn is_local(c: char) -> bool {
        c.is_alphanumeric() || matches!(c, '.' | '_' | '%' | '+' | '-')
    }
    fn is_domain(c: char) -> bool {
        c.is_alphanumeric() || matches!(c, '.' | '-')
    }

    let mut out: Vec<String> = Vec::new();
    for (at, _) in raw_text.match_indices('@') {
        // Expand left over the local part.
        let mut start = at;
        for (idx, ch) in raw_text[..at].char_indices().rev() {
            if is_local(ch) {
                start = idx;
            } else {
                break;
            }
        }
        // A local part cannot start or end with a dot.
        let local = &raw_text[start..at];
        if local.is_empty() || local.starts_with('.') || local.ends_with('.') {
            continue;
        }

        // Expand right over the domain.
        let mut end = at + 1;
        for (idx, ch) in raw_text[at + 1..].char_indices() {
            if is_domain(ch) {
                end = at + 1 + idx + ch.len_utf8();
            } else {
                break;
            }
        }
        let domain = raw_text[at + 1..end].trim_end_matches('.');
        let Some((_, tld)) = domain.rsplit_once('.') else {
            continue;
        };
        if tld.chars().count() < 2 || !tld.chars().all(|c| c.is_alphabetic()) {
            continue;
        }

        let address = format!("{local}@{domain}");
        if !out.contains(&address) {
            out.push(address);
        }
    }
    out
}

/// Replaces German IBANs (DE + 20 digits, single spaces allowed,
/// any ASCII casing — the model sometimes emits lowercase despite the
/// prompt ban) with a fixed mask. Pure — unit-tested.
fn mask_ibans(text: &str) -> String {
    const MASK: &str = "IBAN (maskiert)";
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < bytes.len() {
        if i + 2 <= bytes.len()
            && bytes[i..i + 2].eq_ignore_ascii_case(b"de")
            && (i == 0 || !bytes[i - 1].is_ascii_alphanumeric())
        {
            let mut pos = i + 2;
            let mut digits = 0;
            while pos < bytes.len() && digits < 20 {
                if bytes[pos].is_ascii_digit() {
                    digits += 1;
                    pos += 1;
                } else if bytes[pos] == b' ' {
                    pos += 1;
                } else {
                    break;
                }
            }
            // Exactly 20 digits, and no 21st digit directly attached.
            if digits == 20 && (pos >= bytes.len() || !bytes[pos].is_ascii_digit()) {
                out.push_str(MASK);
                i = pos;
                continue;
            }
        }
        // Copy one char (byte-safe for multibyte UTF-8).
        let ch = text[i..].chars().next().unwrap_or('?');
        out.push(ch);
        i += ch.len_utf8();
    }
    out
}

/// Case-insensitive substring search returning (start, end) byte offsets
/// in the ORIGINAL string. Multi-byte-aware: a haystack char whose
/// lowercase differs in byte length (ẞ→ss, İ→i̇, Kelvin-K→k) still yields
/// exact raw-space boundaries, unlike indices taken from a lowercased copy
/// (see after_each_label). Both offsets are always char boundaries.
fn find_folded(raw: &str, needle: &str, from: usize) -> Option<(usize, usize)> {
    let needle_lc: Vec<char> = needle.chars().flat_map(|c| c.to_lowercase()).collect();
    if needle_lc.is_empty() {
        return if from <= raw.len() {
            Some((from, from))
        } else {
            None
        };
    }
    // (byte offset, char) over the original string.
    let hay: Vec<(usize, char)> = raw.char_indices().collect();
    let mut start = 0;
    while start < hay.len() {
        if hay[start].0 < from {
            start += 1;
            continue;
        }
        let mut ni = 0;
        let mut k = start;
        let mut cur: Vec<char> = Vec::new();
        let mut ci = 0;
        let mut ok = true;
        while ni < needle_lc.len() {
            if ci >= cur.len() {
                if k >= hay.len() {
                    ok = false;
                    break;
                }
                cur = hay[k].1.to_lowercase().collect();
                ci = 0;
                k += 1;
                if cur.is_empty() {
                    continue;
                }
            }
            if cur[ci] != needle_lc[ni] {
                ok = false;
                break;
            }
            ci += 1;
            ni += 1;
        }
        if ok {
            let end = if k > start {
                let (b, c) = hay[k - 1];
                b + c.len_utf8()
            } else {
                hay[start].0
            };
            return Some((hay[start].0, end));
        }
        start += 1;
    }
    None
}

/// Real calendar month length incl. leap years: "31.02.2026" must not
/// become a docDate — the backend IsoDate rejects it → Zod 400 → the outbox
/// parks the document as permanently failed with no recovery path (a retry
/// regenerates the same date from the same text).
fn days_in_month(month: u32, year: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400)) => {
            29
        }
        2 => 28,
        _ => 0,
    }
}

/// German letter-head date: "den 12.09.2026" (also "vom"/"am" are deadline
/// contexts, never the letter date — only "den" qualifies). Returns ISO
/// YYYY-MM-DD or None. Pure — unit-tested.
fn find_letter_date(raw_text: &str) -> Option<String> {
    let mut search_from = 0;
    while let Some((match_at, end)) = find_folded(raw_text, "den ", search_from) {
        // Word boundary: "den" inside "werden"/"jeden" is not a date.
        if match_at > 0
            && raw_text[..match_at]
                .chars()
                .next_back()
                .is_some_and(|c| c.is_alphanumeric())
        {
            search_from = match_at + 1;
            continue;
        }
        let mut pos = end;
        let bytes = raw_text.as_bytes();
        // Day: 1-2 digits.
        let day_start = pos;
        while pos < bytes.len() && bytes[pos].is_ascii_digit() {
            pos += 1;
        }
        let day: u32 = match raw_text[day_start..pos].parse() {
            Ok(day) => day,
            Err(_) => {
                search_from = pos.max(match_at + 1);
                continue;
            }
        };
        if not_dot(bytes, pos) {
            search_from = pos.max(match_at + 1);
            continue;
        }
        pos += 1;
        // Month: 1-2 digits.
        let month_start = pos;
        while pos < bytes.len() && bytes[pos].is_ascii_digit() {
            pos += 1;
        }
        let month: u32 = match raw_text[month_start..pos].parse() {
            Ok(month) => month,
            Err(_) => {
                search_from = pos.max(match_at + 1);
                continue;
            }
        };
        if not_dot(bytes, pos) {
            search_from = pos.max(match_at + 1);
            continue;
        }
        pos += 1;
        // Year: exactly 4 digits + a real calendar date (no Feb 30).
        if pos + 4 <= bytes.len()
            && bytes[pos..pos + 4].iter().all(|b| b.is_ascii_digit())
            && (1..=12).contains(&month)
        {
            let year: u32 = match raw_text[pos..pos + 4].parse() {
                Ok(year) => year,
                Err(_) => {
                    search_from = pos.max(match_at + 1);
                    continue;
                }
            };
            if day >= 1 && day <= days_in_month(month, year) {
                let year_str = &raw_text[pos..pos + 4];
                return Some(format!(
                    "{year}-{month:02}-{day:02}",
                    year = year_str,
                    month = month,
                    day = day
                ));
            }
        }
        search_from = pos.max(match_at + 1);
    }
    None
}

fn not_dot(bytes: &[u8], pos: usize) -> bool {
    pos >= bytes.len() || bytes[pos] != b'.'
}

/// Anything that can turn raw document text into a structured extraction.
/// Implemented by the llama.cpp runner; tests use fakes.
/// Server-side ingest caps (`src/app-api/app-documents.controller.ts`).
///
/// One pass can never exceed them — the runner's JSON schema transcribes the
/// same numbers — but MERGING passes can, and the server answers an over-cap
/// payload with a 400, which the outbox classifies as permanent: the document
/// parks as failed with no retry. Multi-pass extraction is therefore only
/// safe with `clamp_to_ingest_limits` on the way out.
pub const MAX_FACTS: usize = 50;
pub const MAX_DEADLINES: usize = 20;
pub const MAX_OBLIGATIONS: usize = 20;
pub const MAX_ADDRESSES: usize = 10;
pub const MAX_AMOUNTS: usize = 20;
pub const MAX_TAGS: usize = 10;

/// Case- and whitespace-insensitive key for cross-window deduplication: the
/// overlap between windows is there so a detail split across a boundary
/// survives, which means the same detail is reported twice by design.
fn dedup_key(text: &str) -> String {
    text.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Merges a later window's extraction into the running result.
///
/// Scalars are taken from the FIRST window that supplied them: the letterhead
/// (sender, date, subject, category) heads the document, so a later window
/// guessing at them is guessing from the middle of a letter. Collections are
/// appended and deduplicated.
pub fn merge_extraction(base: &mut Extraction, next: Extraction) {
    if base.title.is_none() {
        base.title = next.title;
    }
    if base.sender.is_none() {
        base.sender = next.sender;
    }
    if base.doc_date.is_none() {
        base.doc_date = next.doc_date;
    }
    if base.summary.is_none() {
        base.summary = next.summary;
    }
    if base.expiry_date.is_none() {
        base.expiry_date = next.expiry_date;
    }
    // A later window may recognise the document type the first one could not,
    // but it never overrides a type the letterhead already established.
    if base.category == Category::Other {
        base.category = next.category;
    }
    // `is_active` is a statement about the document as a whole; the first
    // window is the one that saw the subject line.

    let mut seen: std::collections::HashSet<String> =
        base.facts.iter().map(|f| dedup_key(&f.content)).collect();
    for fact in next.facts {
        if seen.insert(dedup_key(&fact.content)) {
            base.facts.push(fact);
        }
    }

    let mut seen: std::collections::HashSet<String> = base
        .deadlines
        .iter()
        .map(|d| format!("{}|{}", dedup_key(&d.label), d.date.0))
        .collect();
    for deadline in next.deadlines {
        if seen.insert(format!("{}|{}", dedup_key(&deadline.label), deadline.date.0)) {
            base.deadlines.push(deadline);
        }
    }

    let mut seen: std::collections::HashSet<String> =
        base.obligations.iter().map(|o| dedup_key(o)).collect();
    for obligation in next.obligations {
        if seen.insert(dedup_key(&obligation)) {
            base.obligations.push(obligation);
        }
    }

    let mut seen: std::collections::HashSet<String> =
        base.addresses.iter().map(|a| dedup_key(&a.address)).collect();
    for address in next.addresses {
        if seen.insert(dedup_key(&address.address)) {
            base.addresses.push(address);
        }
    }

    let amount_key = |a: &Amount| {
        format!(
            "{}|{}|{}",
            dedup_key(a.label.as_deref().unwrap_or("")),
            dedup_key(&a.value),
            dedup_key(a.currency.as_deref().unwrap_or(""))
        )
    };
    let mut seen: std::collections::HashSet<String> =
        base.amounts.iter().map(amount_key).collect();
    for amount in next.amounts {
        if seen.insert(amount_key(&amount)) {
            base.amounts.push(amount);
        }
    }

    let mut seen: std::collections::HashSet<String> =
        base.tags.iter().map(|t| dedup_key(t)).collect();
    for tag in next.tags {
        if seen.insert(dedup_key(&tag)) {
            base.tags.push(tag);
        }
    }
}

/// Brings a merged extraction back inside the server's ingest limits.
///
/// `model_fact_count` is where the deterministic backstop's facts begin.
/// Those are pinned: they are the details the model is known to miss, so
/// dropping them to make room for model output would undo the guarantee the
/// whole backstop exists to provide. Model facts are kept by importance
/// (stable within a rank, so document order survives).
pub fn clamp_to_ingest_limits(extraction: &mut Extraction, model_fact_count: usize) {
    if extraction.facts.len() > MAX_FACTS {
        let split_at = model_fact_count.min(extraction.facts.len());
        let pinned = extraction.facts.split_off(split_at);
        let room = MAX_FACTS.saturating_sub(pinned.len());
        let mut model = std::mem::take(&mut extraction.facts);
        model.sort_by_key(|f| match f.importance {
            Importance::High => 0u8,
            Importance::Medium => 1,
            Importance::Low => 2,
        });
        model.truncate(room);
        extraction.facts = model;
        extraction.facts.extend(pinned);
    }
    extraction.deadlines.truncate(MAX_DEADLINES);
    extraction.obligations.truncate(MAX_OBLIGATIONS);
    extraction.addresses.truncate(MAX_ADDRESSES);
    extraction.amounts.truncate(MAX_AMOUNTS);
    extraction.tags.truncate(MAX_TAGS);
}

/// What one extraction produced, plus how much of the document it actually
/// saw. Coverage is a fact of the RUN, not of the text: a long document is
/// extracted in bounded windows, and a window failing mid-way leaves real
/// coverage below what the length alone would suggest. Persisting it is what
/// keeps the "partially analysed" disclosure honest.
pub struct ExtractionOutcome {
    pub extraction: Extraction,
    pub covered_chars: usize,
    /// Why coverage fell short of the document, when it did.
    ///
    /// A later window failing is not an error for the run as a whole — the
    /// earlier windows' output is kept — but the reason has to reach someone.
    /// It used to go to stderr from inside the library; the caller decides
    /// how to log now.
    pub window_error: Option<String>,
}

pub trait Extractor {
    fn extract(&self, source_hash: &str, raw_text: &str) -> Result<ExtractionOutcome>;
}

/// No-op extractor used when the `llama` feature is disabled or the model
/// is not downloaded: always fails explicitly rather than pretending to work.
pub struct UnimplementedExtractor;

impl Extractor for UnimplementedExtractor {
    fn extract(&self, _source_hash: &str, _raw_text: &str) -> Result<ExtractionOutcome> {
        Err(CoreError::ExtractionFailed {
            path: "llama.cpp".into(),
            message: "local model runner not available (build with --features llama and download a model)".into(),
        })
    }
}

/// Parses the local model's JSON output into an `Extraction`, validating the
/// source_hash is present and looks like sha256 hex.
pub fn parse_extraction(json: &str) -> Result<Extraction> {
    use serde::de::Error as _;

    let extraction: Extraction = serde_json::from_str(json)?;
    if extraction.source_hash.len() != 64
        || !extraction
            .source_hash
            .chars()
            .all(|c| c.is_ascii_hexdigit())
    {
        return Err(CoreError::Serialization(serde_json::Error::custom(
            "source_hash must be 64 hex characters",
        )));
    }
    Ok(extraction)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Address, Deadline, IsoDate};

    #[test]
    fn prompt_contains_privacy_filter() {
        assert!(EXTRACTION_SYSTEM_PROMPT.contains("NICHT speichern"));
        assert!(EXTRACTION_SYSTEM_PROMPT.contains("Fristen"));
    }

    #[test]
    fn prompt_pins_actionable_small_details() {
        // Eval (Bescheid fixture): BG-Nummer, Berater-Kontakt, summary,
        // docDate, amounts[] and addresses[] were dropped before these
        // lines existed — the prompt must name them explicitly.
        for needle in [
            "BG-Nummer",
            "Telefon",
            "Sprechzeiten",
            "Briefdatum",
            "summary",
            "docDate",
            "amounts",
            "addresses",
        ] {
            assert!(
                EXTRACTION_SYSTEM_PROMPT.contains(needle),
                "prompt lost pin for {needle}"
            );
        }
    }

    #[test]
    fn parse_extraction_accepts_valid_json() {
        let json = format!(
            r#"{{"sourceHash":"{}","category":"jobcenter","facts":[],"deadlines":[],"obligations":[],"addresses":[],"amounts":[],"tags":[],"isActive":true}}"#,
            "f".repeat(64)
        );
        let extraction = parse_extraction(&json).unwrap();
        assert_eq!(extraction.source_hash, "f".repeat(64));
    }

    #[test]
    fn parse_extraction_rejects_invalid_hash() {
        let json = r#"{"sourceHash":"not-a-hash","category":"other","facts":[],"deadlines":[],"obligations":[],"addresses":[],"amounts":[],"tags":[],"isActive":true}"#;
        assert!(parse_extraction(json).is_err());
    }

    #[test]
    fn unimplemented_extractor_fails_explicitly() {
        let extractor = UnimplementedExtractor;
        assert!(extractor.extract("hash", "text").is_err());
    }

    #[test]
    fn user_prompt_contains_hash_and_document() {
        let hash = "a".repeat(64);
        let prompt = build_user_prompt(&hash, "Bewilligungsbescheid");
        assert!(prompt.contains(&hash));
        assert!(prompt.contains("Bewilligungsbescheid"));
        assert!(prompt.starts_with("sourceHash"));
    }

    #[test]
    fn user_prompt_truncates_long_documents() {
        let long_text = "x".repeat(MAX_PROMPT_DOC_CHARS + 500);
        let prompt = build_user_prompt(&"a".repeat(64), &long_text);
        assert!(prompt.contains("[Dokument gekürzt]"));
        assert!(prompt.chars().count() < MAX_PROMPT_DOC_CHARS + 500);
    }

    #[test]
    fn user_prompt_marks_short_documents_untruncated() {
        let prompt = build_user_prompt(&"a".repeat(64), "kurz");
        assert!(!prompt.contains("[Dokument gekürzt]"));
    }

    fn empty_extraction() -> Extraction {
        Extraction {
            source_hash: "a".repeat(64),
            file_name: None,
            title: None,
            sender: None,
            category: crate::types::Category::Other,
            doc_date: None,
            summary: None,
            facts: vec![],
            deadlines: vec![],
            obligations: vec![],
            addresses: vec![],
            amounts: vec![],
            tags: vec![],
            is_active: true,
            expiry_date: None,
        }
    }

    fn fact_contents(extraction: &Extraction) -> Vec<&str> {
        extraction
            .facts
            .iter()
            .map(|f| f.content.as_str())
            .collect()
    }

    #[test]
    fn ensure_key_details_adds_reference_and_contact_facts() {
        let raw = "BG-Nummer: 1234567BG89012\nFrau Schmidt, Zimmer A2.14\n\
                   Telefon: 030 55578912\nSprechzeiten: Dienstag 9:00-12:00 Uhr";
        let mut extraction = empty_extraction();
        ensure_key_details(raw, &mut extraction);

        let contents = fact_contents(&extraction).join("\n");
        assert!(contents.contains("1234567BG89012"), "{contents}");
        assert!(contents.contains("030 55578912"), "{contents}");
        assert!(contents.contains("Dienstag"), "{contents}");
        assert!(contents.contains("A2.14"), "{contents}");
    }

    #[test]
    fn ensure_key_details_skips_values_the_model_already_captured() {
        let raw = "BG-Nummer: 1234567BG89012\nTelefon: 030 55578912";
        let mut extraction = empty_extraction();
        extraction.facts.push(Fact {
            content: "Die BG-Nummer 1234567BG89012 ist oben genannt.".into(),
            importance: Importance::High,
        });
        extraction.facts.push(Fact {
            content: "Erreichbar unter 030 55578912.".into(),
            importance: Importance::Medium,
        });
        ensure_key_details(raw, &mut extraction);

        // No duplicates added.
        assert_eq!(extraction.facts.len(), 2);
    }

    #[test]
    fn ensure_key_details_ignores_unlabeled_numbers() {
        // Bare amounts, IBAN-shaped and date-shaped text without a captured
        // label must not become facts.
        let raw = "Betrag: 563,00 Euro\nIBAN: DE12 3456 7890 1234 5678 90\n\
                   Geboren am 03.04.1985\nAnteile 12/34";
        let mut extraction = empty_extraction();
        ensure_key_details(raw, &mut extraction);

        assert!(extraction.facts.is_empty());
    }

    #[test]
    fn ensure_key_details_matches_labels_case_insensitively() {
        let raw = "AKTENZEICHEN 12 XY 34\nTELEFON 030/12345";
        let mut extraction = empty_extraction();
        ensure_key_details(raw, &mut extraction);

        let contents = fact_contents(&extraction).join("\n");
        assert!(contents.contains("12 XY 34"), "{contents}");
        assert!(contents.contains("030/12345"), "{contents}");
    }

    #[test]
    fn ensure_key_details_caps_added_facts() {
        let raw = (0..20)
            .map(|i| format!("Aktenzeichen AZ-{i}"))
            .collect::<Vec<_>>()
            .join("\n");
        let mut extraction = empty_extraction();
        ensure_key_details(&raw, &mut extraction);

        assert_eq!(extraction.facts.len(), 12);
    }

    fn fact(content: &str, importance: Importance) -> Fact {
        Fact {
            content: content.to_string(),
            importance,
        }
    }

    fn extraction_for_merge() -> Extraction {
        let mut e = empty_extraction();
        e.category = Category::Other;
        e
    }

    #[test]
    fn merge_keeps_the_first_window_authoritative_for_scalars() {
        let mut base = extraction_for_merge();
        base.title = Some("Bescheid".into());
        base.category = Category::Jobcenter;

        let mut next = extraction_for_merge();
        next.title = Some("Seite 2".into());
        next.sender = Some("Jobcenter Berlin".into());
        next.category = Category::Bank;

        merge_extraction(&mut base, next);

        // The letterhead heads the document; a later window guessing at the
        // title or the type is guessing from the middle of a letter.
        assert_eq!(base.title.as_deref(), Some("Bescheid"));
        assert_eq!(base.category, Category::Jobcenter);
        // ...but a field the first window left empty is still worth filling.
        assert_eq!(base.sender.as_deref(), Some("Jobcenter Berlin"));
    }

    #[test]
    fn merge_adopts_a_category_the_first_window_could_not_name() {
        let mut base = extraction_for_merge();
        let mut next = extraction_for_merge();
        next.category = Category::Versicherung;
        merge_extraction(&mut base, next);
        assert_eq!(base.category, Category::Versicherung);
    }

    #[test]
    fn merge_deduplicates_the_window_overlap() {
        // Windows overlap on purpose, so the same detail IS reported twice.
        let mut base = extraction_for_merge();
        base.facts = vec![fact("Die Frist endet am 01.05.2026.", Importance::High)];
        base.obligations = vec!["Mietvertrag einreichen".into()];
        base.tags = vec!["Jobcenter".into()];
        base.deadlines = vec![Deadline {
            label: "Widerspruch".into(),
            date: IsoDate("2026-05-01".into()),
            kind: None,
        }];

        let mut next = extraction_for_merge();
        // Same content, different whitespace and case — still the same fact.
        next.facts = vec![
            fact("die frist   endet am 01.05.2026.", Importance::Medium),
            fact("Neuer Fakt.", Importance::Low),
        ];
        next.obligations = vec!["MIETVERTRAG EINREICHEN".into(), "Kontoauszüge".into()];
        next.tags = vec!["jobcenter".into()];
        next.deadlines = vec![Deadline {
            label: "widerspruch".into(),
            date: IsoDate("2026-05-01".into()),
            kind: None,
        }];

        merge_extraction(&mut base, next);

        assert_eq!(base.facts.len(), 2);
        assert_eq!(base.obligations.len(), 2);
        assert_eq!(base.tags.len(), 1);
        assert_eq!(base.deadlines.len(), 1);
    }

    #[test]
    fn merge_keeps_a_same_label_deadline_with_a_different_date() {
        let mut base = extraction_for_merge();
        base.deadlines = vec![Deadline {
            label: "Zahlung".into(),
            date: IsoDate("2026-05-01".into()),
            kind: None,
        }];
        let mut next = extraction_for_merge();
        next.deadlines = vec![Deadline {
            label: "Zahlung".into(),
            date: IsoDate("2026-06-01".into()),
            kind: None,
        }];
        merge_extraction(&mut base, next);
        // Two instalments, not a duplicate.
        assert_eq!(base.deadlines.len(), 2);
    }

    #[test]
    fn clamp_holds_the_merged_result_inside_the_server_caps() {
        // Merging N windows can exceed caps one pass can never exceed, and
        // an over-cap payload is a 400 the outbox parks as permanent.
        let mut e = extraction_for_merge();
        e.facts = (0..80)
            .map(|i| fact(&format!("Fakt {i}"), Importance::Medium))
            .collect();
        e.deadlines = (0..30)
            .map(|i| Deadline {
                label: format!("Frist {i}"),
                date: IsoDate("2026-05-01".into()),
                kind: None,
            })
            .collect();
        e.obligations = (0..30).map(|i| format!("Pflicht {i}")).collect();
        e.addresses = (0..15)
            .map(|i| Address {
                purpose: None,
                address: format!("Strasse {i}"),
            })
            .collect();
        e.amounts = (0..30)
            .map(|i| Amount {
                label: None,
                value: format!("{i},00"),
                currency: None,
            })
            .collect();
        e.tags = (0..20).map(|i| format!("tag{i}")).collect();

        let all_model = e.facts.len();
        clamp_to_ingest_limits(&mut e, all_model);

        assert_eq!(e.facts.len(), MAX_FACTS);
        assert_eq!(e.deadlines.len(), MAX_DEADLINES);
        assert_eq!(e.obligations.len(), MAX_OBLIGATIONS);
        assert_eq!(e.addresses.len(), MAX_ADDRESSES);
        assert_eq!(e.amounts.len(), MAX_AMOUNTS);
        assert_eq!(e.tags.len(), MAX_TAGS);
    }

    #[test]
    fn clamp_pins_backstop_facts_and_prefers_important_model_facts() {
        let mut e = extraction_for_merge();
        // 60 model facts, only the last 5 marked High.
        e.facts = (0..60)
            .map(|i| {
                fact(
                    &format!("Modellfakt {i}"),
                    if i >= 55 { Importance::High } else { Importance::Low },
                )
            })
            .collect();
        let model_fact_count = e.facts.len();
        // 6 backstop facts appended after, as ensure_key_details does.
        for i in 0..6 {
            e.facts.push(fact(&format!("Referenznummer {i}"), Importance::Medium));
        }

        clamp_to_ingest_limits(&mut e, model_fact_count);

        assert_eq!(e.facts.len(), MAX_FACTS);
        let joined = e
            .facts
            .iter()
            .map(|f| f.content.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        // Every backstop fact survives — they are exactly the details the
        // model is known to miss, so dropping them undoes the guarantee.
        for i in 0..6 {
            assert!(joined.contains(&format!("Referenznummer {i}")), "{joined}");
        }
        // High-importance model facts outrank Low ones for the rest.
        for i in 55..60 {
            assert!(joined.contains(&format!("Modellfakt {i}")), "{joined}");
        }
    }

    #[test]
    fn clamp_leaves_an_ordinary_extraction_untouched() {
        let mut e = extraction_for_merge();
        e.facts = vec![
            fact("Zuerst", Importance::Low),
            fact("Dann", Importance::High),
        ];
        clamp_to_ingest_limits(&mut e, 2);
        // Under the cap, document order is preserved — no reordering by rank.
        assert_eq!(e.facts[0].content, "Zuerst");
        assert_eq!(e.facts[1].content, "Dann");
    }

    #[test]
    fn read_plate_matches_shape_not_a_character_run() {
        // The case that motivated shape matching: prose runs straight on
        // after the plate, so any "take a run of characters" reader either
        // swallows the sentence or stops at arbitrary punctuation.
        assert_eq!(
            read_plate("B-AM 4711 läuft vom 01.01.2026 bis zum 31.12.2026"),
            Some("B-AM 4711".to_string())
        );
        assert_eq!(read_plate("M-XY 12E,"), Some("M-XY 12E".to_string()));
        assert_eq!(read_plate("HH-AB 1234\n"), Some("HH-AB 1234".to_string()));
        // Two-letter group without a space is still unambiguous.
        assert_eq!(read_plate("B-AM4711"), Some("B-AM4711".to_string()));
    }

    #[test]
    fn read_plate_rejects_reference_numbers_and_prose() {
        // A reference number is the dangerous false positive — it has the
        // letters-hyphen-digits shape but runs on past the number.
        assert_eq!(read_plate("KFZ-2026-884512"), None);
        assert_eq!(read_plate("AZ-12345678"), None);
        // District group longer than three letters is not a plate.
        assert_eq!(read_plate("ABCD-EF 12"), None);
        assert_eq!(read_plate("kein Kennzeichen hier"), None);
        assert_eq!(read_plate(""), None);
        // Single-letter group with no separator stays ambiguous → rejected.
        assert_eq!(read_plate("B-A4711"), None);
    }

    #[test]
    fn find_emails_reads_addresses_out_of_prose() {
        assert_eq!(
            find_emails("Per E-Mail erreichen Sie uns unter kfz-service@example.de."),
            vec!["kfz-service@example.de".to_string()]
        );
        // Trailing sentence punctuation must not join the domain.
        assert_eq!(
            find_emails("Schreiben Sie an a.b+c@sub.example.co.uk!"),
            vec!["a.b+c@sub.example.co.uk".to_string()]
        );
        // Deduplicated: letterhead and footer repeat the same address.
        assert_eq!(
            find_emails("info@amt.de\nText\ninfo@amt.de"),
            vec!["info@amt.de".to_string()]
        );
    }

    #[test]
    fn find_emails_skips_non_addresses() {
        // "@" as shorthand, no domain dot, and a numeric TLD are all skipped.
        assert!(find_emails("Preis @ 5 Euro").is_empty());
        assert!(find_emails("user@localhost").is_empty());
        assert!(find_emails("user@example.12").is_empty());
        assert!(find_emails("@amt.de").is_empty());
        assert!(find_emails("nutzer.@amt.de").is_empty());
    }

    #[test]
    fn ensure_key_details_recovers_the_a4_label_set() {
        // The six details that were 0/5 on EVERY model run — never flaky,
        // always absent. Worst case: the model produced nothing at all.
        let raw = "Versicherungsnummer: KFZ-2026-884512\n\
                   Ihr Vertrag für das Fahrzeug mit dem amtlichen Kennzeichen\n\
                   B-AM 4711 läuft vom 01.01.2026 bis zum 31.12.2026.\n\
                   Per E-Mail erreichen Sie uns unter kfz-service@example.de.\n\
                   Bürozeiten Montag bis Donnerstag 10:00-15:00 Uhr.\n\
                   Die Wohnung hat eine Wohnfläche von ca. 68 qm.\n\
                   Das Mietverhältnis beginnt am 01.11.2026.";
        let mut extraction = empty_extraction();
        ensure_key_details(raw, &mut extraction);

        let contents = fact_contents(&extraction).join("\n");
        for needle in [
            "KFZ-2026-884512",
            "B-AM 4711",
            "kfz-service@example.de",
            "10:00-15:00",
            "68 qm",
            "01.11.2026",
        ] {
            assert!(contents.contains(needle), "missing {needle} in:\n{contents}");
        }
        // The document's own wording is preserved, not relabelled.
        assert!(contents.contains("Bürozeiten:"), "{contents}");
    }

    #[test]
    fn find_letter_date_reads_german_briefkopf() {
        assert_eq!(
            find_letter_date("Berlin, den 12.09.2026\nText"),
            Some("2026-09-12".to_string())
        );
        assert_eq!(
            find_letter_date("Berlin, den 2.1.2026"),
            Some("2026-01-02".to_string())
        );
        // "den" inside normal words is not a date; malformed dates are skipped.
        assert_eq!(find_letter_date("Sie werden informiert."), None);
        assert_eq!(find_letter_date("den 99.99.2026"), None);
        assert_eq!(find_letter_date("kein Datum hier"), None);
    }

    #[test]
    fn find_letter_date_rejects_impossible_calendar_dates() {
        // The backend IsoDate rejects these → 400 → the document would park
        // as permanently failed, so the extractor must not emit them.
        assert_eq!(find_letter_date("Berlin, den 31.02.2026"), None);
        assert_eq!(find_letter_date("Berlin, den 30.02.2024"), None);
        assert_eq!(find_letter_date("Berlin, den 31.04.2026"), None);
        assert_eq!(find_letter_date("Berlin, den 00.01.2026"), None);
        assert_eq!(find_letter_date("Berlin, den 32.01.2026"), None);
        // Leap years still work.
        assert_eq!(
            find_letter_date("Berlin, den 29.02.2024"),
            Some("2024-02-29".to_string())
        );
        assert_eq!(find_letter_date("Berlin, den 29.02.2026"), None);
        assert_eq!(
            find_letter_date("Berlin, den 29.02.2000"),
            Some("2000-02-29".to_string())
        );
        assert_eq!(find_letter_date("Berlin, den 29.02.1900"), None);
    }

    #[test]
    fn find_letter_date_matches_den_case_insensitively() {
        assert_eq!(
            find_letter_date("Berlin, DEN 12.09.2026"),
            Some("2026-09-12".to_string())
        );
        assert_eq!(
            find_letter_date("Berlin, Den 12.09.2026"),
            Some("2026-09-12".to_string())
        );
    }

    #[test]
    fn folded_search_survives_length_changing_case_folds() {
        // ẞ (3 bytes) lowercases to "ss" (2 bytes): indices taken from a
        // lowercased copy would slice mid-char and panic. The search must
        // operate in raw-space and the date after the fold must still parse.
        let raw = "GRÜẞE\nBerlin, den 12.09.2026";
        assert_eq!(find_letter_date(raw), Some("2026-09-12".to_string()));
        // Mixed-case labels keep matching (no recall regression vs the old
        // lowercase-everything search).
        let mut extraction = empty_extraction();
        ensure_key_details("Bg-Nummer: 1234567BG89012", &mut extraction);
        let contents = fact_contents(&extraction).join("\n");
        assert!(contents.contains("1234567BG89012"), "{contents}");
    }

    #[test]
    fn mask_ibans_masks_lowercase_prefix_too() {
        assert_eq!(
            mask_ibans("Konto de12 3456 7890 1234 5678 90 prüfen."),
            "Konto IBAN (maskiert) prüfen."
        );
    }

    #[test]
    fn ensure_key_details_fills_missing_doc_date() {
        let mut extraction = empty_extraction();
        ensure_key_details("Berlin, den 28.08.2026\nFrist 30.09.2026", &mut extraction);
        assert_eq!(
            extraction.doc_date,
            Some(crate::types::IsoDate("2026-08-28".to_string()))
        );
    }

    #[test]
    fn ensure_key_details_keeps_model_doc_date() {
        let mut extraction = empty_extraction();
        extraction.doc_date = Some(crate::types::IsoDate("2026-01-01".to_string()));
        ensure_key_details("Berlin, den 28.08.2026", &mut extraction);
        assert_eq!(
            extraction.doc_date,
            Some(crate::types::IsoDate("2026-01-01".to_string()))
        );
    }

    #[test]
    fn ensure_key_details_dedups_repeated_occurrences() {
        // Letterhead + body repeat the same contact block: one fact each,
        // no duplicates.
        let raw = "Telefon: 030 55578912\nSprechzeiten: Dienstag 9-12 Uhr\n\
                   Ihr Ansprechpartner: Frau Schmidt, Telefon 030 55578912, \
                   Sprechzeiten Dienstag 9-12 Uhr";
        let mut extraction = empty_extraction();
        ensure_key_details(raw, &mut extraction);

        let contents = fact_contents(&extraction);
        assert_eq!(
            contents
                .iter()
                .filter(|c| c.contains("030 55578912"))
                .count(),
            1,
            "{contents:?}"
        );
        assert_eq!(
            contents.iter().filter(|c| c.contains("Dienstag")).count(),
            1,
            "{contents:?}"
        );
    }

    #[test]
    fn ensure_key_details_cuts_hours_at_sentence_boundary() {
        let raw = "Sprechzeiten Dienstag 9-12 Uhr. Bei Fragen rufen Sie an.";
        let mut extraction = empty_extraction();
        ensure_key_details(raw, &mut extraction);

        let contents = fact_contents(&extraction).join("\n");
        assert!(
            contents.contains("Sprechzeiten: Dienstag 9-12 Uhr."),
            "{contents}"
        );
        assert!(!contents.contains("Bei Fragen"), "{contents}");
    }

    #[test]
    fn ensure_key_details_spells_reference_labels_correctly() {
        let raw = "BG-Nummer: 1234567BG89012";
        let mut extraction = empty_extraction();
        ensure_key_details(raw, &mut extraction);

        let contents = fact_contents(&extraction).join("\n");
        assert!(
            contents.contains("Referenznummer (BG-Nummer): 1234567BG89012."),
            "{contents}"
        );
    }

    #[test]
    fn mask_ibans_replaces_german_ibans() {
        assert_eq!(
            mask_ibans("Girokonto DE12 3456 7890 1234 5678 90 überzogen."),
            "Girokonto IBAN (maskiert) überzogen."
        );
        assert_eq!(
            mask_ibans("IBAN:DE12345678901234567890."),
            "IBAN:IBAN (maskiert)."
        );
    }

    #[test]
    fn mask_ibans_leaves_ordinary_text_alone() {
        // No DE-prefix, too few digits, DEN-word: untouched. (A complete
        // lowercase IBAN *is* masked — see the test above.)
        assert_eq!(mask_ibans("Betrag 563,00 Euro."), "Betrag 563,00 Euro.");
        assert_eq!(mask_ibans("DEN 123456789."), "DEN 123456789.");
        assert_eq!(mask_ibans("MODELL 2026."), "MODELL 2026.");
        assert_eq!(
            mask_ibans("Konto DE12 3456 (unvollständig)."),
            "Konto DE12 3456 (unvollständig)."
        );
    }

    #[test]
    fn ensure_key_details_masks_ibans_in_facts() {
        let mut extraction = empty_extraction();
        extraction.facts.push(Fact {
            content: "Stand auf DE12 3456 7890 1234 5678 90.".into(),
            importance: Importance::Medium,
        });
        ensure_key_details("Sonstiges ohne Labels.", &mut extraction);

        assert_eq!(extraction.facts[0].content, "Stand auf IBAN (maskiert).");
    }
}
