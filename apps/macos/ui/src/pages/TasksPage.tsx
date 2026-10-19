import { useCallback, useEffect, useState } from "react";
import type { PageId, SyncState } from "../App";
import { ipc } from "../ipc";
import { useI18n } from "../i18n";
import { toDayString, todayLocalDay } from "../dates";
import { Translatable } from "../translate-ui";
import type { RemoteTask, SuggestedTask, TaskStatus } from "../types";

const COLUMNS = [
  { status: "open", label: "tasks.colOpen", example: "tasks.example.open" },
  { status: "in_progress", label: "tasks.colProgress", example: "tasks.example.progress" },
  { status: "done", label: "tasks.colDone", example: "tasks.example.done" },
] as const;

export function TasksPage({ sync, goTo }: { sync: SyncState; goTo: (p: PageId) => void }) {
  const { t } = useI18n();
  const [suggested, setSuggested] = useState<SuggestedTask[]>([]);
  const [message, setMessage] = useState<string>("");
  // Guards confirm/dismiss against double-clicks: the backend calls are
  // idempotent, but a second click mid-flight surfaces the raw Rust error
  // past i18n — disabling the row while one action is in flight.
  const [pendingId, setPendingId] = useState<number | null>(null);
  // Same guard for server tasks: a second click mid-PATCH would fire from the
  // same render snapshot and race the first.
  const [movingId, setMovingId] = useState<string | null>(null);

  const reload = useCallback(() => {
    ipc.listSuggestedTasks().then(setSuggested).catch(() => setSuggested([]));
  }, []);

  useEffect(reload, [reload]);

  const tasks: RemoteTask[] = sync.updates?.tasks ?? [];
  const pendingSuggestions = suggested.filter((task) => task.status === "pending");
  const todayStr = todayLocalDay();
  // Demo Board: while no real task has synced yet, each empty column shows
  // one tagged example card so the workflow is legible before pairing.
  const showExamples = tasks.length === 0;

  const confirm = async (id: number) => {
    if (pendingId !== null) return;
    setPendingId(id);
    setMessage(t("tasks.creating"));
    try {
      await ipc.confirmSuggestedTask(id);
      setMessage(t("tasks.created"));
      sync.refresh();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setPendingId(null);
      reload();
    }
  };

  // The board was read-only: tasks arrived from the server and could only be
  // closed elsewhere, so the page showed work it could not act on. Optimism
  // is deliberately avoided — `sync.refresh()` re-pulls, so the board shows
  // what the server actually accepted rather than what we hoped it would.
  const move = async (task: RemoteTask, status: TaskStatus) => {
    if (movingId !== null) return;
    setMovingId(task.id);
    setMessage("");
    try {
      await ipc.updateTaskStatus(task.id, status);
      sync.refresh();
    } catch (e) {
      setMessage(t("tasks.updateFailed", { error: String(e) }));
    } finally {
      setMovingId(null);
    }
  };

  const dismiss = async (id: number) => {
    if (pendingId !== null) return;
    setPendingId(id);
    try {
      await ipc.dismissSuggestedTask(id);
    } catch (e) {
      setMessage(String(e));
    } finally {
      setPendingId(null);
      reload();
    }
  };

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="font-serif text-3xl">{t("tasks.title")}</h1>
      <p className="mt-1 mb-6 text-sm" style={{ color: "var(--text-muted)" }}>
        {t("tasks.subtitle")}
      </p>

      {message && (
        <p className="mb-4 text-sm" style={{ color: "var(--accent)" }}>
          {message}
        </p>
      )}

      {pendingSuggestions.length > 0 && (
        <section className="card mb-8 p-5">
          <h2 className="mb-1 font-serif text-lg">{t("tasks.suggTitle")}</h2>
          <p className="mb-3 text-xs" style={{ color: "var(--text-muted)" }}>
            {t("tasks.suggHint")}
          </p>
          {pendingSuggestions.map((task) => (
            <div
              key={task.id}
              className="flex items-center justify-between border-b py-2 last:border-b-0"
              style={{ borderColor: "var(--border)" }}
            >
              <span className="text-sm">
                <Translatable text={task.title} />
              </span>
              <div className="flex gap-2">
                <button
                  className="btn btn-primary py-1 text-xs"
                  onClick={() => confirm(task.id)}
                  disabled={pendingId !== null}
                >
                  {t("tasks.confirm")}
                </button>
                <button
                  className="btn btn-ghost py-1 text-xs"
                  onClick={() => dismiss(task.id)}
                  disabled={pendingId !== null}
                >
                  {t("tasks.dismiss")}
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      <div className="grid grid-cols-3 gap-4">
        {COLUMNS.map((col) => {
          // "missed" has no column of its own — those tasks still need
          // action, so they surface in Open (their due date already renders
          // in overdue red below) instead of vanishing from the board. Same
          // for any unknown future status (RemoteTask.status is a wide
          // string): visible in Open beats invisible everywhere.
          const items = tasks.filter(
            (task) =>
              task.status === col.status ||
              (col.status === "open" &&
                (task.status === "missed" ||
                  !["open", "in_progress", "done", "missed"].includes(task.status))),
          );
          return (
            <div key={col.status}>
              <h2
                className="mb-2 text-xs font-semibold uppercase tracking-wider"
                style={{ color: "var(--text-muted)" }}
              >
                {t(col.label)} ({items.length})
              </h2>
              {items.map((task) => (
                <div key={task.id} className="card mb-2 p-4">
                  <div className="text-sm font-medium">
                    <Translatable text={task.title} />
                  </div>
                  {task.dueDate && (
                    <div
                      className="mt-1 text-xs"
                      style={{
                        color:
                          task.status !== "done" && toDayString(task.dueDate) < todayStr
                            ? "#dc2626"
                            : "var(--text-muted)",
                      }}
                    >
                      {toDayString(task.dueDate)}
                    </div>
                  )}
                  {task.priority === "high" && task.status !== "done" && (
                    <span
                      className="mt-2 inline-block rounded-full px-2 py-0.5 text-xs"
                      style={{ background: "#dc262622", color: "#dc2626" }}
                    >
                      {t("tasks.urgent")}
                    </span>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {task.status !== "done" ? (
                      <>
                        {task.status !== "in_progress" && (
                          <button
                            className="btn btn-ghost py-1 text-xs"
                            disabled={movingId !== null}
                            onClick={() => void move(task, "in_progress")}
                          >
                            {t("tasks.start")}
                          </button>
                        )}
                        <button
                          className="btn btn-primary py-1 text-xs"
                          disabled={movingId !== null}
                          onClick={() => void move(task, "done")}
                        >
                          {t("tasks.complete")}
                        </button>
                      </>
                    ) : (
                      <button
                        className="btn btn-ghost py-1 text-xs"
                        disabled={movingId !== null}
                        onClick={() => void move(task, "open")}
                      >
                        {t("tasks.reopen")}
                      </button>
                    )}
                  </div>
                </div>
              ))}
              {items.length === 0 && showExamples && (
                <div
                  className="rounded-lg border border-dashed p-4"
                  style={{ borderColor: "var(--border)" }}
                >
                  <div className="text-sm font-medium">{t(col.example)}</div>
                  <span
                    className="mt-2 inline-block rounded-full px-2 py-0.5 text-xs"
                    style={{ border: "1px solid var(--accent)", color: "var(--accent)" }}
                  >
                    {t("tasks.exampleTag")}
                  </span>
                </div>
              )}
              {items.length === 0 && !showExamples && (
                <div
                  className="rounded-lg border border-dashed p-4 text-center text-xs"
                  style={{ borderColor: "var(--border)", color: "var(--text-muted)" }}
                >
                  {t("tasks.noItems")}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!sync.paired && (
        <p className="mt-8 text-sm" style={{ color: "var(--text-muted)" }}>
          {t("tasks.unpaired")}
        </p>
      )}

      {showExamples && (
        <>
          <div className="my-6 border-t" style={{ borderColor: "var(--border)" }} />
          <p className="text-sm italic" style={{ color: "var(--text-muted)" }}>
            {t("tasks.examplesVanish")}
          </p>
          {!sync.paired && (
            <button className="btn btn-primary mt-3" onClick={() => goTo("settings")}>
              {t("tasks.pairInSettings")}
            </button>
          )}
        </>
      )}
    </div>
  );
}
