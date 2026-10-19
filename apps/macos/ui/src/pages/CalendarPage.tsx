import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import type { SyncState } from "../App";
import { ipc } from "../ipc";
import { MONTHS, WEEKDAYS, formatDaysLeft, useI18n } from "../i18n";
import { daysUntilDay as daysUntil, toDayString, todayLocalDay } from "../dates";
import type { RemoteDeadline } from "../types";

export function CalendarPage({ sync }: { sync: SyncState }) {
  const { t, lang } = useI18n();
  const today = new Date();
  // One state object for both fields: two rapid clicks from one render must
  // step twice, and separate year/month states would apply the same stale
  // snapshot twice (losing one step) — or double-fire under StrictMode if
  // one updater called the other.
  const [[year, month], setYearMonth] = useState<[number, number]>([
    today.getFullYear(),
    today.getMonth(),
  ]);
  const [dragOver, setDragOver] = useState(false);
  const [analyzing, setAnalyzing] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  // Per-row toggle guard: a rapid double-click would fire two PATCHes from
  // the same render snapshot (second overwrites first); disable while one
  // is in flight.
  const [togglingId, setTogglingId] = useState<string | null>(null);

  // Drop-To-Analyze: ingest → local extract per file, then ONE push + pull
  // for the whole batch (a pull per file is N full sync cycles), so dropped
  // letters actually end up as deadlines instead of sitting `pending`.
  // Outcomes accumulate into counted summaries — a per-file last-writer
  // message would hide earlier failures in a batch.
  const ingestPaths = async (paths: string[]) => {
    let added = 0;
    let duplicates = 0;
    let failed = 0;
    for (const p of paths) {
      const name = p.split("/").pop() ?? p;
      setAnalyzing(name);
      try {
        const r = await ipc.ingestDocument(p);
        if (r.duplicate || !r.document) {
          duplicates++;
          continue;
        }
        await ipc.extractDocument(r.document.id);
        added++;
      } catch {
        failed++;
      } finally {
        setAnalyzing(null);
      }
    }
    if (added + duplicates + failed > 0) {
      setMessage(
        t("docs.folderDone", { added, duplicates, skipped: 0, failed }),
      );
    }
    if (added > 0) {
      // Push best-effort (fails unpaired — the docs still extract
      // locally); pull via refresh so new deadlines render.
      await ipc.syncNow().catch(() => undefined);
      sync.refresh();
    }
  };

  // OS file drops arrive with real paths via Tauri (browser File objects
  // carry no path); the overlay highlight is driven by the drag handlers
  // on the calendar card below.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ paths: string[] }>("tauri://drag-drop", (event) => {
          setDragOver(false);
          void ingestPaths(event.payload.paths);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  const chooseFile = async () => {
    try {
      const selected = await open({
        multiple: true,
        // Exactly what `detect_kind` accepts (extraction/mod.rs). The old
        // list made docx/txt/md look unsupported and — worse — omitted
        // "heic", the format every iPhone photo arrives in.
        filters: [
          {
            name: "Documents",
            extensions: [
              "pdf",
              "docx",
              "txt",
              "md",
              "png",
              "jpg",
              "jpeg",
              "heic",
              "tiff",
            ],
          },
        ],
      });
      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      await ingestPaths(paths);
    } catch (e) {
      setMessage(String(e));
    }
  };

  const deadlines: RemoteDeadline[] = (sync.updates?.deadlines ?? [])
    .slice()
    .sort((a, b) => a.deadlineDate.localeCompare(b.deadlineDate));

  // Drop-To-Analyze: with no deadlines yet the calendar itself invites a
  // drop; the overlay also appears mid-drag once deadlines exist.
  const showDrop = deadlines.length === 0;

  const byDay = useMemo(() => {
    const map = new Map<string, RemoteDeadline[]>();
    for (const d of deadlines) {
      const day = toDayString(d.deadlineDate);
      const list = map.get(day) ?? [];
      list.push(d);
      map.set(day, list);
    }
    return map;
  }, [deadlines]);

  // Monday-first grid
  const first = new Date(Date.UTC(year, month, 1));
  const startOffset = (first.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells: (number | null)[] = [
    ...Array(startOffset).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const fmt = (m: number) => `${year}-${String(m + 1).padStart(2, "0")}`;
  // Functional updaters: two rapid clicks from one render must step twice,
  // not apply the same stale month/year step twice (losing one step).
  const stepMonth = (delta: -1 | 1) => {
    setYearMonth(([y, m]): [number, number] => {
      const next = m + delta;
      if (next < 0) return [y - 1, 11];
      if (next > 11) return [y + 1, 0];
      return [y, next];
    });
  };
  const todayStr = todayLocalDay(today);

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-serif text-3xl">{t("cal.title")}</h1>
        <div className="flex items-center gap-2">
          <button
            className="btn btn-ghost"
            onClick={() => stepMonth(-1)}
          >
            ←
          </button>
          <span className="w-36 text-center font-serif text-lg">
            {MONTHS[lang][month]} {year}
          </span>
          <button
            className="btn btn-ghost"
            onClick={() => stepMonth(1)}
          >
            →
          </button>
        </div>
      </div>

      {message && (
        <p className="mb-4 text-sm" style={{ color: "var(--accent)" }}>
          {message}
        </p>
      )}

      <div
        className="card relative p-5"
        style={
          showDrop || dragOver
            ? { borderColor: "var(--accent)", borderWidth: 2 }
            : undefined
        }
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
        }}
      >
        {(showDrop || dragOver) && (
          <div
            className="absolute inset-0 z-10 flex items-center justify-center rounded-xl p-6"
            style={{
              background: "color-mix(in srgb, var(--bg) 72%, transparent)",
              backdropFilter: "blur(2px)",
            }}
          >
            <div className="card w-full max-w-sm p-6 text-center">
              <svg
                width="40"
                height="40"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--accent)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                className="mx-auto"
                aria-hidden="true"
              >
                <path d="M6 2h8l4 4v14H6z" />
                <path d="M14 2v5h5" />
                <path d="M12 11v6M9 14h6" />
              </svg>
              <h3 className="mt-2 font-serif text-lg">{t("cal.dropTitle")}</h3>
              <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
                {t("cal.dropBody")}
              </p>
              <button
                className="btn btn-primary mt-4"
                onClick={() => void chooseFile()}
              >
                {t("cal.chooseFile")}
              </button>
              <p className="mt-2 text-xs" style={{ color: "var(--text-muted)" }}>
                {t("cal.dragHere")}
              </p>
            </div>
          </div>
        )}
        <div className="mb-2 grid grid-cols-7 gap-1 text-center text-xs" style={{ color: "var(--text-muted)" }}>
          {WEEKDAYS[lang].map((w) => (
            <div key={w}>{w}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((day, i) => {
            if (day === null) return <div key={`e${i}`} />;
            const dateStr = `${fmt(month)}-${String(day).padStart(2, "0")}`;
            const dayDeadlines = byDay.get(dateStr) ?? [];
            const isToday = dateStr === todayStr;
            return (
              <div
                key={dateStr}
                className="min-h-[64px] rounded-lg border p-1 text-xs"
                style={{
                  borderColor: isToday ? "var(--accent)" : "transparent",
                  background:
                    dayDeadlines.length > 0
                      ? "color-mix(in srgb, var(--accent) 8%, transparent)"
                      : "transparent",
                }}
              >
                <div style={{ color: isToday ? "var(--accent)" : "var(--text-muted)", fontWeight: isToday ? 700 : 400 }}>
                  {day}
                </div>
                {dayDeadlines.slice(0, 2).map((d) => (
                  <div
                    key={d.id}
                    className="mt-0.5 truncate rounded px-1 py-0.5"
                    title={d.label}
                    style={{
                      background: "#dc262622",
                      color: d.completedAt ? "var(--text-muted)" : "#dc2626",
                      textDecoration: d.completedAt ? "line-through" : "none",
                    }}
                  >
                    {d.label}
                  </div>
                ))}
                {dayDeadlines.length > 2 && (
                  <div style={{ color: "var(--text-muted)" }}>+{dayDeadlines.length - 2}</div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {analyzing && (
        <div className="card mx-auto mt-6 w-full max-w-sm animate-pulse p-6 text-center">
          <svg
            width="40"
            height="40"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--accent)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mx-auto"
            aria-hidden="true"
          >
            <path d="M6 2h8l4 4v14H6z" />
            <path d="M14 2v5h5" />
          </svg>
          <p className="mt-2 font-serif text-lg">{t("cal.analyzing")}</p>
          <div
            className="mx-auto mt-3 h-1.5 w-full overflow-hidden rounded-full"
            style={{ background: "var(--border)" }}
          >
            <div className="h-full w-2/5 rounded-full" style={{ background: "var(--accent)" }} />
          </div>
          <p className="mt-2 truncate text-xs" style={{ color: "var(--text-muted)" }}>
            {analyzing}
          </p>
        </div>
      )}

      <h2 className="mb-3 mt-8 font-serif text-lg">{t("cal.all")}</h2>
      {deadlines.length === 0 && (
        <p className="card p-6 text-center text-sm" style={{ color: "var(--text-muted)" }}>
          {t("cal.noDeadlines")}
        </p>
      )}
      {deadlines.map((d) => {
        const days = daysUntil(d.deadlineDate);
        const overdue = days < 0 && !d.completedAt;
        const toggleDone = async () => {
          if (togglingId !== null) return;
          setTogglingId(d.id);
          try {
            await ipc.completeDeadline(d.id, !d.completedAt);
            sync.refresh();
          } catch (e) {
            setMessage(String(e));
          } finally {
            setTogglingId(null);
          }
        };
        return (
          <div key={d.id} className="card mb-2 flex items-center justify-between px-5 py-3">
            <div>
              <span style={{ textDecoration: d.completedAt ? "line-through" : "none", opacity: d.completedAt ? 0.55 : 1 }}>
                {d.label}
              </span>
              {d.completedAt && (
                <span className="ml-2 rounded-full px-2 py-0.5 text-xs" style={{ background: "#05966922", color: "#059669" }}>
                  {t("cal.done")}
                </span>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-3">
              {!d.completedAt && (
                <span
                  className="text-sm"
                  style={{ color: overdue ? "#dc2626" : days <= 14 ? "#ca8a04" : "var(--text-muted)", fontWeight: overdue || days <= 7 ? 600 : 400 }}
                >
                  {toDayString(d.deadlineDate)} · {formatDaysLeft(t, days)}
                </span>
              )}
              <button
                className="btn btn-ghost text-xs"
                onClick={() => void toggleDone()}
                disabled={togglingId !== null}
                title={d.completedAt ? t("cal.reopen") : t("cal.complete")}
              >
                {d.completedAt ? t("cal.reopen") : t("cal.complete")}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
