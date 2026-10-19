import { useEffect, useState } from "react";
import type { PageId, SyncState } from "../App";
import { ipc } from "../ipc";
import { formatDaysLeft, useI18n } from "../i18n";
import type { TKey } from "../i18n";
import { Translatable } from "../translate-ui";
import { daysUntilDay as daysUntil, toDayString } from "../dates";
import type { DocumentRow, RemoteDeadline, RemoteHint } from "../types";

const SEVERITY_COLOR: Record<string, string> = {
  high: "#dc2626",
  medium: "#ca8a04",
  low: "var(--text-muted)",
};

const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

const SEVERITY_LABEL = {
  high: "hints.high",
  medium: "hints.medium",
  low: "hints.low",
} as const;

/**
 * Server severities are a bare string on the wire. Resolve to a known label
 * key instead of interpolating one: an unrecognised severity used to build a
 * key that does not exist and rendered as the raw template.
 */
function severityLabelKey(severity: string): TKey {
  return SEVERITY_LABEL[severity as keyof typeof SEVERITY_LABEL] ?? "hints.low";
}

export function Dashboard({ sync, goTo }: { sync: SyncState; goTo: (p: PageId) => void }) {
  const { t } = useI18n();
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [hints, setHints] = useState<RemoteHint[]>([]);
  // Load failures must read as failures, not as empty data: an empty list
  // and a failed IPC call otherwise render identically.
  const [docsError, setDocsError] = useState<string | null>(null);
  const [hintsError, setHintsError] = useState<string | null>(null);

  // Local doc counts refresh whenever synced remote state changes, so the
  // counts don't go stale after ingest/extract/delete on other pages.
  useEffect(() => {
    ipc
      .listDocuments()
      .then((d) => {
        setDocs(d);
        setDocsError(null);
      })
      .catch((e) => {
        setDocs([]);
        setDocsError(String(e));
      });
  }, [sync.updates]);

  useEffect(() => {
    if (!sync.paired) {
      setHints([]);
      return;
    }
    ipc
      .fetchHints()
      .then((h) => {
        setHints(h);
        setHintsError(null);
      })
      .catch((e) => {
        setHints([]);
        setHintsError(String(e));
      });
  }, [sync.paired, sync.updates]);

  const deadlines: RemoteDeadline[] = sync.updates?.deadlines ?? [];
  // Fristen-Radar: every open deadline (not just the top 5), oldest first,
  // each annotated with the server hints that reference its document
  // (deadline collisions, Widerspruch warnings) — the hints' documentIds
  // match document-sourced deadlines via sourceId.
  const openDeadlines = deadlines
    .filter((d) => !d.completedAt)
    .sort((a, b) => a.deadlineDate.localeCompare(b.deadlineDate));
  const sortedHints = [...hints].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3),
  );
  const hintsFor = (deadline: RemoteDeadline): RemoteHint[] => {
    const source = deadline.sourceId;
    if (!source) return [];
    return sortedHints.filter((h) => h.documentIds.includes(source));
  };
  // Each source reports separately: a `??` chain showed only the first, so a
  // failing sync hid behind a failing hints call — the opposite of the
  // "failures must read as failures" intent above.
  const errors = [docsError, hintsError, sync.syncError].filter(
    (e): e is string => e !== null,
  );
  const pendingDocs = docs.filter((d) => d.status === "pending").length;
  const openTasks = (sync.updates?.tasks ?? []).filter(
    (task) => task.status === "open" || task.status === "in_progress",
  );

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="font-serif text-3xl">{t("dash.title")}</h1>
      <p className="mt-1 mb-8 text-sm" style={{ color: "var(--text-muted)" }}>
        {t("dash.subtitle")}
      </p>

      {errors.length > 0 && (
        <div className="card mb-6 p-4 text-sm" style={{ color: "#dc2626" }}>
          {errors.map((e) => (
            <p key={e}>⚠ {e}</p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-3 gap-4">
        <button className="card p-5 text-left" onClick={() => goTo("documents")}>
          <div className="text-3xl font-serif">{docs.length}</div>
          <div className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
            {t("dash.localDocs")}
          </div>
        </button>
        <button className="card p-5 text-left" onClick={() => goTo("calendar")}>
          <div className="text-3xl font-serif">{openDeadlines.length}</div>
          <div className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
            {t("dash.upcoming")}
          </div>
        </button>
        <button className="card p-5 text-left" onClick={() => goTo("tasks")}>
          <div className="text-3xl font-serif">{openTasks.length}</div>
          <div className="mt-1 text-sm" style={{ color: "var(--text-muted)" }}>
            {t("dash.openTasks")}
          </div>
        </button>
      </div>

      {openDeadlines.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 font-serif text-lg">{t("dash.nextDeadlines")}</h2>
          {openDeadlines.map((d) => {
            const days = daysUntil(d.deadlineDate);
            const linked = hintsFor(d);
            const overdue = days < 0;
            return (
              <button
                key={d.id}
                className="card mb-2 flex w-full items-center justify-between gap-4 px-5 py-3 text-left"
                onClick={() => goTo("calendar")}
              >
                <span className="min-w-0">
                  <span className="block truncate">{d.label}</span>
                  {overdue && (
                    <span
                      className="mt-1 inline-block rounded-full px-2 py-0.5 text-xs"
                      style={{ background: "#dc262622", color: "#dc2626" }}
                    >
                      {formatDaysLeft(t, days)}
                    </span>
                  )}
                  {linked.length > 0 && (
                    <span className="mt-1 flex flex-wrap gap-1">
                      {linked.map((h, j) => (
                        <span
                          key={j}
                          className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs"
                          style={{
                            background: `color-mix(in srgb, ${SEVERITY_COLOR[h.severity] ?? SEVERITY_COLOR.low} 12%, transparent)`,
                            color: SEVERITY_COLOR[h.severity] ?? SEVERITY_COLOR.low,
                          }}
                        >
                          <span
                            className="inline-block h-1.5 w-1.5 rounded-full"
                            style={{
                              background:
                                SEVERITY_COLOR[h.severity] ?? SEVERITY_COLOR.low,
                            }}
                          />
                          {h.title}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                <span
                  className="shrink-0 text-sm"
                  style={{
                    color:
                      days <= 7 ? "#dc2626" : days <= 14 ? "#ca8a04" : "var(--text-muted)",
                    fontWeight: days <= 7 ? 600 : 400,
                  }}
                >
                  {toDayString(d.deadlineDate)}
                  {" · "}
                  {formatDaysLeft(t, days)}
                </span>
              </button>
            );
          })}
        </section>
      )}

      {sortedHints.length > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 font-serif text-lg">{t("dash.hints")}</h2>
          {sortedHints.map((h, i) => (
            <div key={i} className="card mb-2 px-5 py-3">
              <div className="flex items-center gap-2">
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ background: SEVERITY_COLOR[h.severity] ?? SEVERITY_COLOR.low }}
                />
                <span className="font-medium">
                  <Translatable text={h.title} />
                </span>
                <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {t(severityLabelKey(h.severity))}
                </span>
              </div>
              <p className="mt-1 text-sm" style={{ color: "var(--text-muted)", whiteSpace: "pre-wrap" }}>
                <Translatable text={h.body} />
              </p>
            </div>
          ))}
        </section>
      )}

      {pendingDocs > 0 && (
        <section className="mt-10">
          <h2 className="mb-3 font-serif text-lg">{t("dash.awaiting")}</h2>
          <button className="btn btn-primary" onClick={() => goTo("documents")}>
            {t("dash.goAnalyze", { n: pendingDocs })}
          </button>
        </section>
      )}

      {!sync.paired && (
        <section className="card mt-10 p-5">
          <h2 className="font-serif text-lg">{t("dash.pairTitle")}</h2>
          <p className="mt-2 text-sm" style={{ color: "var(--text-muted)" }}>
            {t("dash.pairBody")}
          </p>
          <button className="btn btn-primary mt-3" onClick={() => goTo("settings")}>
            {t("dash.pairCta")}
          </button>
        </section>
      )}
    </div>
  );
}
