import { useState } from "react";
import { ipc } from "./ipc";
import { LANG_LABELS, useI18n } from "./i18n";

/**
 * A short foreign string (task title, fact, obligation…) with a tiny
 * target-language button. First click translates on-device via the
 * `translate_text` command (models download lazily on first use, hence the
 * busy state); second click flips back to the original. Failures fall back
 * to the source text silently — a missing translation must never hide data.
 *
 * Source defaults to German (the product's document language) and the
 * button hides entirely when the UI already runs in the source language.
 */
const MAX_TRANSLATE_CHARS = 2000; // mirror of Rust translate.rs: the backend truncates silently
const TRANSLATION_CACHE_MAX = 200;

// Module-level cache keyed by from+to+text: toggling or re-rendering must
// not re-pay IPC + model load per instance. The target language is part of
// the key, so a UI-language switch can never hit a stale entry. Bounded
// FIFO — translations are small, but the cache must not grow forever.
const translationCache = new Map<string, string>();

function cacheGet(from: string, to: string, text: string): string | undefined {
  return translationCache.get(`${from}${to}${text}`);
}

function cacheSet(from: string, to: string, text: string, translated: string): void {
  if (translationCache.size >= TRANSLATION_CACHE_MAX) {
    const oldest = translationCache.keys().next();
    if (!oldest.done) translationCache.delete(oldest.value);
  }
  translationCache.set(`${from}${to}${text}`, translated);
}
export function Translatable({ text, from = "de" }: { text: string; from?: string }) {
  const { t, lang } = useI18n();
  const [translated, setTranslated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (lang === from) return <>{text}</>;

  const onClick = async () => {
    if (busy) return;
    if (translated) {
      setTranslated(null);
      return;
    }
    const cached = cacheGet(from, lang, text);
    if (cached !== undefined) {
      setTranslated(cached);
      return;
    }
    setBusy(true);
    try {
      const r = await ipc.translateText(text, from, lang);
      cacheSet(from, lang, text, r.text);
      setTranslated(r.text);
    } catch {
      // Keep the original text — see docstring.
    } finally {
      setBusy(false);
    }
  };

  // The backend truncates past MAX_TRANSLATE_CHARS without a signal — mark
  // a translation of a long source as partial so it never reads as complete.
  const truncated = text.length > MAX_TRANSLATE_CHARS;

  return (
    <>
      <span>
        {translated ?? text}
        {translated && truncated ? " […]" : ""}
      </span>{" "}
      <button
        type="button"
        title={translated ? t("tr.originalTitle") : t("tr.translateTitle")}
        onClick={() => void onClick()}
        disabled={busy}
        className="rounded px-1 text-xs"
        style={{
          border: "1px solid var(--border)",
          color: translated ? "var(--accent)" : "var(--text-muted)",
          borderColor: translated ? "var(--accent)" : "var(--border)",
          cursor: busy ? "wait" : "pointer",
          whiteSpace: "nowrap",
        }}
      >
        {busy ? "…" : LANG_LABELS[lang]}
      </button>
    </>
  );
}
