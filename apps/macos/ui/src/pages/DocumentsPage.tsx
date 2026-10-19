import { useCallback, useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { SyncState } from "../App";
import { ipc } from "../ipc";
import { useI18n } from "../i18n";
import { formatLocalDateTime } from "../dates";
import { Translatable } from "../translate-ui";
import type { DocumentRow, RemoteDocument } from "../types";

const SEVERITY_COLOR: Record<string, string> = {
  high: "#dc2626",
  medium: "#ca8a04",
  low: "var(--text-muted)",
};

interface Extraction {
  title?: string | null;
  category?: string;
  summary?: string | null;
  facts?: { content: string; importance: string }[];
  deadlines?: { label: string; date: string }[];
  obligations?: string[];
}

export function parseExtraction(json: string | null): Extraction | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Extraction;
  } catch {
    return null;
  }
}

const STATUS_FILTERS = ["", "pending", "extracted", "synced", "failed"] as const;

const KNOWN_CATEGORIES = [
  "mietvertrag",
  "jobcenter",
  "bank",
  "visa",
  "versicherung",
  "other",
] as const;

/**
 * The local model returns a free-text category — normalize (case/space)
 * and whitelist it so an unexpected value ("Jobcenter", " mietvertrag")
 * falls back to "other" instead of rendering an empty badge.
 */
function normalizeCategory(raw: string | null | undefined): (typeof KNOWN_CATEGORIES)[number] {
  const cleaned = raw?.trim().toLowerCase() ?? "other";
  return (KNOWN_CATEGORIES as readonly string[]).includes(cleaned)
    ? (cleaned as (typeof KNOWN_CATEGORIES)[number])
    : "other";
}

export function DocumentsPage({ sync }: { sync: SyncState }) {
  const { t, lang } = useI18n();
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string>("");
  const [folderBusy, setFolderBusy] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const reload = useCallback(() => {
    ipc.listDocuments().then(setDocs).catch(() => setDocs([]));
  }, []);

  useEffect(reload, [reload]);

  // Drag & drop onto the page ingests by path (Tauri tauri://drag-drop).
  // Sequential awaits: concurrent ingests raced setMessage (last writer
  // won nondeterministically) — same shape as CalendarPage.ingestPaths.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ paths: string[] }>("tauri://drag-drop", (event) => {
          void (async () => {
            for (const p of event.payload.paths) {
              try {
                const r = await ipc.ingestDocument(p);
                setMessage(
                  r.duplicate
                    ? t("docs.msgDuplicate", { name: p })
                    : t("docs.msgAdded", { name: r.document?.file_name ?? p }),
                );
              } catch (e) {
                setMessage(String(e));
              }
            }
            // One reload per drop, not per file.
            reload();
          })();
        }),
      )
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [reload, t]);

  // Parsing every extraction JSON on every render is O(n) JSON.parse per
  // keystroke/progress tick — memoize per row so re-renders from setMessage
  // (e.g. per-file folder progress) don't re-parse the whole list. Depends
  // on [docs, filter], not on the derived `shown` array (a fresh identity
  // every render would defeat the memo).
  const rows = useMemo(
    () =>
      docs
        .filter((d) => !filter || d.status === filter)
        .map((d) => {
          const ext = parseExtraction(d.extraction_json);
          return {
            doc: d,
            ext,
            category: normalizeCategory(ext?.category),
          };
        }),
    [docs, filter],
  );
  const selected = docs.find((d) => d.id === selectedId) ?? null;

  const extract = async (id: string, scannedFallback = true) => {
    setBusy(id);
    setMessage(t("docs.msgAnalyzing"));
    try {
      await ipc.extractDocument(id);
      setMessage(t("docs.msgDone"));
    } catch (e) {
      const msg = String(e);
      // Local Vision OCR came up empty on a scan: with the opt-in server
      // scan enabled, send the image to Sonnet once and run the local
      // extract on the transcribed text. One attempt — a second failure
      // surfaces as-is instead of looping.
      const kind = docs.find((d) => d.id === id)?.kind;
      if (scannedFallback && msg.includes("scanned document") && kind === "image") {
        try {
          const details = await ipc.pairingDetails().catch(() => null);
          if (details?.serverScanEnabled) {
            await ipc.scanImage(id, lang);
            setMessage(t("docs.msgServerScanned"));
            await extract(id, false);
            return;
          }
        } catch (fallbackErr) {
          setMessage(String(fallbackErr));
          return;
        }
      }
      setMessage(msg.includes("scanned document") ? t("docs.errScanned") : msg);
    } finally {
      setBusy(null);
      reload();
    }
  };

  // Manual server scan for failed image rows (the automatic fallback above
  // only fires on the scanned-document error, not on other failures).
  const serverScan = async (id: string) => {
    setBusy(id);
    try {
      await ipc.scanImage(id, lang);
      setMessage(t("docs.msgServerScanned"));
      await extract(id, false);
    } catch (e) {
      setMessage(String(e));
    } finally {
      setBusy(null);
      reload();
    }
  };

  // Deletion is irreversible AND now reaches the server, so it is confirmed
  // rather than fired on a single click next to "Analysieren".
  const remove = async (id: string) => {
    setConfirmDeleteId(null);
    try {
      const r = await ipc.deleteDocument(id);
      setSelectedId(null);
      setMessage(t(r.remoteDeleted ? "docs.deletedBoth" : "docs.deletedLocal"));
    } catch (e) {
      // Fail-closed on the Rust side: nothing was deleted in either place, so
      // say that plainly instead of leaving the row to reappear unexplained.
      setMessage(t("docs.deleteFailed", { error: String(e) }));
    } finally {
      reload();
    }
  };

  // Parked sync entries (5× transient or 1× 4xx) have no recovery path
  // without this: requeue resets them to pending for the next push.
  const requeue = async (id: string) => {
    try {
      const r = await ipc.requeueFailedDocument(id);
      setMessage(t("docs.requeued", { n: r.requeued }));
      sync.refresh();
    } catch (e) {
      setMessage(String(e));
    } finally {
      reload();
    }
  };

  // Batch folder ingest: pick a directory once, then ingest → extract each
  // readable document SEQUENTIALLY with per-file progress (local inference
  // is the bottleneck — parallel extracts would thrash it and interleave
  // messages). Unsupported/oversized files are counted as skipped, never
  // fatal; a final push + pull lands everything server-side.
  const chooseFolder = async () => {
    if (folderBusy) return;
    let selected: string | string[] | null;
    try {
      selected = await open({ directory: true });
    } catch (e) {
      setMessage(String(e));
      return;
    }
    const dir = Array.isArray(selected) ? selected[0] : selected;
    if (!dir) return;
    setFolderBusy(true);
    try {
      const scan = await ipc.listFolderFiles(dir);
      const ingestable = scan.files.filter((f) => f.supported && !f.too_large);
      const skipped = scan.files.length - ingestable.length;
      if (ingestable.length === 0) {
        setMessage(t("docs.folderEmpty"));
        return;
      }
      let added = 0;
      let duplicates = 0;
      let failed = 0;
      for (const [i, f] of ingestable.entries()) {
        // Progress text re-renders the whole list per file — throttle to
        // every 5th file (plus the last) instead of O(n²) mounts on folders.
        if (i % 5 === 0 || i === ingestable.length - 1) {
          setMessage(t("docs.folderProgress", { done: i + 1, total: ingestable.length, name: f.file_name }));
        }
        try {
          const r = await ipc.ingestDocument(f.path);
          if (r.duplicate || !r.document) {
            duplicates++;
            continue;
          }
          // Counted as added only after a successful extract — a failed
          // extract must land in `failed`, never in both counters at once.
          await ipc.extractDocument(r.document.id);
          added++;
        } catch {
          failed++;
        }
      }
      // One reload for the whole batch: a reload per file is O(n²) IPC +
      // re-renders on large folders (the list only grows).
      reload();
      // Push best-effort, then pull so Tasks/Calendar/Dashboard refresh. A
      // failed push must read as a warning appended to the success counts,
      // never as a silent "done".
      const pushError = await ipc
        .syncNow()
        .then(() => null)
        .catch((e: unknown) => String(e));
      setMessage(
        t("docs.folderDone", { added, duplicates, skipped, failed }) +
          (scan.truncated ? ` ${t("docs.folderTruncated")}` : "") +
          (pushError ? ` ${t("docs.pushFailed", { error: pushError })}` : ""),
      );
      sync.refresh();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setFolderBusy(false);
      reload();
    }
  };

  const statusLabel = (s: string): string =>
    s === "pending"
      ? t("status.pending")
      : s === "extracted"
        ? t("status.extracted")
        : s === "synced"
          ? t("status.synced")
          : t("status.failed");

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-serif text-3xl">{t("docs.title")}</h1>
      <p className="mt-1 mb-4 text-sm" style={{ color: "var(--text-muted)" }}>
        {t("docs.dropHint")}
      </p>

      <div className="mb-5 flex gap-2">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s || "all"}
            className={`btn ${filter === s ? "btn-primary" : "btn-ghost"}`}
            onClick={() => setFilter(s)}
          >
            {s === "" ? t("docs.filterAll") : statusLabel(s)}
          </button>
        ))}
        <button
          className="btn btn-ghost ml-auto"
          onClick={() => void chooseFolder()}
          disabled={folderBusy}
        >
          {folderBusy ? t("docs.extracting") : t("docs.folder")}
        </button>
      </div>

      {message && (
        <p className="mb-4 text-sm" style={{ color: "var(--accent)" }}>
          {message}
        </p>
      )}

      {rows.length === 0 && (
        <div className="card p-10 text-center" style={{ color: "var(--text-muted)" }}>
          {t("docs.empty")}
        </div>
      )}

      {rows.map(({ doc: d, ext, category }) => {
        return (
          <button
            key={d.id}
            className={`${category} card mb-2 block w-full px-5 py-4 text-left`}
            onClick={() => setSelectedId(d.id)}
          >
            <div className="flex items-center justify-between">
              <span className="font-medium">{ext?.title ?? d.file_name ?? d.id}</span>
              <span
                className="rounded-full px-2 py-0.5 text-xs"
                style={{
                  background: "color-mix(in srgb, var(--cat) 15%, transparent)",
                  color: "var(--cat)",
                }}
              >
                {t(`cat.${category}`)}
              </span>
            </div>
            <div
              className="mt-1 flex items-center gap-2 text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              <span>{formatLocalDateTime(d.created_at)}</span>
              <span>·</span>
              <span>{statusLabel(d.status)}</span>
              {d.coverage_truncated && d.status !== "pending" && (
                <span
                  className="rounded-full px-2 py-0.5"
                  style={{ background: "#ca8a0422", color: "#ca8a04" }}
                  title={t("docs.partialBody")}
                >
                  {t("docs.partial")}
                </span>
              )}
              {d.status === "pending" && (
                <span
                  className="btn btn-ghost ml-auto py-1 text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    void extract(d.id);
                  }}
                >
                  {busy === d.id ? t("docs.extracting") : t("docs.extract")}
                </span>
              )}
              {d.status === "failed" && (
                <>
                  <span
                    className="btn btn-ghost ml-auto py-1 text-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      void requeue(d.id);
                    }}
                  >
                    {t("docs.requeue")}
                  </span>
                  {d.kind === "image" && (
                    <span
                      className="btn btn-ghost py-1 text-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        void serverScan(d.id);
                      }}
                    >
                      {busy === d.id ? t("docs.extracting") : t("docs.serverScan")}
                    </span>
                  )}
                </>
              )}
            </div>
          </button>
        );
      })}

      {selected && (
        <DocumentDetail
          doc={selected}
          busy={busy === selected.id}
          confirming={confirmDeleteId === selected.id}
          onExtract={() => extract(selected.id)}
          onDelete={() => setConfirmDeleteId(selected.id)}
          onConfirmDelete={() => void remove(selected.id)}
          onCancelDelete={() => setConfirmDeleteId(null)}
          onClose={() => {
            setConfirmDeleteId(null);
            setSelectedId(null);
          }}
        />
      )}

      <ServerAnalyses sync={sync} />
    </div>
  );
}

function ServerAnalyses({ sync }: { sync: SyncState }) {
  const { t, lang } = useI18n();
  const [questions, setQuestions] = useState<Record<string, string>>({});
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<string | null>(null);

  const docs = (sync.updates?.documents ?? []).filter(
    (d) => d.insights.length > 0,
  );
  if (!sync.paired) return null;
  if (docs.length === 0) {
    return (
      <section className="mt-10">
        <h2 className="mb-1 font-serif text-lg">{t("analysis.title")}</h2>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          {t("analysis.empty")}
        </p>
      </section>
    );
  }

  const ask = async (doc: RemoteDocument) => {
    const q = (questions[doc.id] ?? "").trim();
    if (!q || loading) return;
    setLoading(doc.id);
    try {
      const answer = await ipc.askDocument(doc.id, q, lang);
      setAnswers((a) => ({ ...a, [doc.id]: answer }));
    } catch (e) {
      setAnswers((a) => ({
        ...a,
        [doc.id]: t("chat.errPrefix", { error: String(e) }),
      }));
    } finally {
      setLoading(null);
    }
  };

  return (
    <section className="mt-10">
      <h2 className="mb-1 font-serif text-lg">{t("analysis.title")}</h2>
      <p className="mb-4 text-sm" style={{ color: "var(--text-muted)" }}>
        {t("analysis.subtitle")}
      </p>
      {docs.map((doc) => (
        <div key={doc.id} className="card mb-3 p-5">
          <div className="font-medium">
            {doc.title ?? doc.fileName ?? doc.id}
          </div>
          <ul className="mt-3 space-y-2">
            {doc.insights.map((insight) => (
              <li key={insight.id} className="flex gap-2 text-sm">
                <span
                  className="mt-1.5 inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{
                    background:
                      SEVERITY_COLOR[insight.severity] ?? SEVERITY_COLOR.low,
                  }}
                />
                <span>
                  <strong>
                    <Translatable text={insight.title} />
                  </strong>
                  <br />
                  <Translatable text={insight.body} />
                  {insight.severity === "high" && (
                    <>
                      <br />
                      <span style={{ color: "var(--text-muted)" }}>
                        {t("analysis.referral")}
                      </span>
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {answers[doc.id] && (
            <p
              className="mt-3 text-sm"
              style={{ whiteSpace: "pre-wrap", userSelect: "text" }}
            >
              {answers[doc.id]}
            </p>
          )}
          <div className="mt-3 flex gap-2">
            <input
              className="card flex-1 px-3 py-2 text-sm outline-none"
              placeholder={t("analysis.askPh")}
              value={questions[doc.id] ?? ""}
              onChange={(e) =>
                setQuestions((q) => ({ ...q, [doc.id]: e.target.value }))
              }
              disabled={loading === doc.id}
              onKeyDown={(e) => {
                if (e.key === "Enter") void ask(doc);
              }}
            />
            <button
              className="btn btn-primary py-2 text-sm"
              disabled={loading === doc.id || !(questions[doc.id] ?? "").trim()}
              onClick={() => void ask(doc)}
            >
              {loading === doc.id ? t("analysis.thinking") : t("analysis.ask")}
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}

function DocumentDetail(props: {
  doc: DocumentRow;
  busy: boolean;
  confirming: boolean;
  onExtract: () => void;
  onDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const doc = props.doc;
  const ext = parseExtraction(doc.extraction_json);
  const category = normalizeCategory(ext?.category);
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-8"
      onClick={props.onClose}
    >
      <div
        className={`${category} card max-h-full w-[620px] overflow-y-auto p-7`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-1 flex items-center gap-3">
          <h2 className="font-serif text-2xl">
            {ext?.title ?? doc.file_name ?? "Dokument"}
          </h2>
          <span
            className="rounded-full px-2 py-0.5 text-xs"
            style={{
              background: "color-mix(in srgb, var(--cat) 15%, transparent)",
              color: "var(--cat)",
            }}
          >
            {t(`cat.${category}`)}
          </span>
        </div>
        <p className="mb-5 text-xs" style={{ color: "var(--text-muted)" }}>
          {doc.file_name} · {doc.status} · {doc.source_hash.slice(0, 12)}…
        </p>

        {doc.coverage_truncated && (
          <div
            className="card mb-4 p-4 text-sm"
            style={{ borderColor: "#ca8a04", color: "#ca8a04" }}
            role="status"
          >
            <strong>{t("docs.partial")}</strong>
            <div className="mt-1">{t("docs.partialBody")}</div>
          </div>
        )}

        {ext?.summary && (
          <p className="card mb-4 p-4 text-sm">
            <Translatable text={ext.summary} />
          </p>
        )}

        {(ext?.facts?.length ?? 0) > 0 && (
          <Section title={t("docs.facts")}>
            <ul className="list-disc pl-5">
              {ext!.facts!.map((f, i) => (
                <li key={i}>
                  <Translatable text={f.content} />
                </li>
              ))}
            </ul>
          </Section>
        )}

        {(ext?.deadlines?.length ?? 0) > 0 && (
          <Section title={t("docs.deadlines")}>
            <ul>
              {ext!.deadlines!.map((dl, i) => (
                <li key={i}>
                  <strong style={{ color: "#dc2626" }}>{dl.date}</strong> —{" "}
                  <Translatable text={dl.label} />
                </li>
              ))}
            </ul>
          </Section>
        )}

        {(ext?.obligations?.length ?? 0) > 0 && (
          <Section title={t("docs.obligations")}>
            <ul className="list-disc pl-5">
              {ext!.obligations!.map((o, i) => (
                <li key={i}>
                  <Translatable text={o} />
                </li>
              ))}
            </ul>
          </Section>
        )}

        {!ext && doc.raw_text && (
          <details className="text-sm">
            <summary
              className="cursor-pointer"
              style={{ color: "var(--text-muted)" }}
            >
              {t("docs.rawText")}
            </summary>
            <pre
              className="mt-2 whitespace-pre-wrap font-sans"
              style={{ userSelect: "text" }}
            >
              {doc.raw_text.slice(0, 4000)}
            </pre>
          </details>
        )}

        <div className="mt-6 flex justify-between">
          {doc.status === "pending" ? (
            <button className="btn btn-primary" disabled={props.busy} onClick={props.onExtract}>
              {props.busy ? t("docs.analyzing") : t("docs.analyze")}
            </button>
          ) : (
            <span />
          )}
          {props.confirming ? (
            <div className="flex items-center gap-2">
              <span className="text-xs" style={{ color: "#dc2626" }}>
                {t("docs.deleteConfirm")}
              </span>
              <button className="btn btn-ghost" onClick={props.onCancelDelete}>
                {t("docs.deleteCancel")}
              </button>
              <button
                className="btn btn-primary shrink-0"
                style={{ background: "#dc2626", borderColor: "#dc2626" }}
                onClick={props.onConfirmDelete}
              >
                {t("docs.delete")}
              </button>
            </div>
          ) : (
            <button className="btn btn-ghost" onClick={props.onDelete}>
              {t("docs.delete")}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Section(props: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-4">
      <h3
        className="mb-2 text-xs font-semibold uppercase tracking-wider"
        style={{ color: "var(--text-muted)" }}
      >
        {props.title}
      </h3>
      <div className="text-sm">{props.children}</div>
    </div>
  );
}
