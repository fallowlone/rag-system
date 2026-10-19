import { useCallback, useEffect, useMemo, useState } from "react";
import { Dashboard } from "./pages/Dashboard";
import { DocumentsPage } from "./pages/DocumentsPage";
import { CalendarPage } from "./pages/CalendarPage";
import { TasksPage } from "./pages/TasksPage";
import { ChatPage, type ChatMessage } from "./pages/ChatPage";
import { SettingsPage } from "./pages/SettingsPage";
import { ipc } from "./ipc";
import type { RemoteData } from "./types";
import { DICTS, LANG_LABELS, LangContext, detectLang } from "./i18n";
import type { Lang } from "./i18n";

export type PageId =
  | "dashboard"
  | "documents"
  | "calendar"
  | "tasks"
  | "chat"
  | "settings";

const NAV: { id: PageId; label: string; icon: string }[] = [
  { id: "dashboard", label: "nav.dashboard", icon: "◧" },
  { id: "documents", label: "nav.documents", icon: "▤" },
  { id: "calendar", label: "nav.calendar", icon: "◫" },
  { id: "tasks", label: "nav.tasks", icon: "✓" },
  { id: "chat", label: "nav.chat", icon: "◈" },
  { id: "settings", label: "nav.settings", icon: "⚙" },
];

export interface SyncState {
  paired: boolean;
  updates: RemoteData | null;
  syncError: string | null;
  refresh: () => void;
}

export default function App() {
  const [page, setPage] = useState<PageId>("dashboard");
  const [dark, setDark] = useState(
    localStorage.getItem("dokumente.theme") === "dark",
  );
  const [lang, setLangState] = useState<Lang>(detectLang);
  const [paired, setPaired] = useState(false);
  const [updates, setUpdates] = useState<RemoteData | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const [quarantine, setQuarantine] = useState<string | null>(null);
  // Last pull restarted from scratch server-side (stale cursor past
  // tombstone retention): the local snapshot was wiped first, so banner
  // the refresh instead of passing it as an ordinary delta.
  const [resynced, setResynced] = useState(false);
  // Chat turns live here (not in ChatPage) so navigating between pages no
  // longer unmounts and wipes the conversation.
  const [chatTurns, setChatTurns] = useState<ChatMessage[]>([]);
  const [refreshTick, setRefreshTick] = useState(0);

  const t = useCallback(
    (key: keyof typeof DICTS.de, params?: Record<string, string | number>) => {
      // Fail-safe: an unknown key (backend-driven severity, stale cache)
      // renders as the key, never as a TypeError that blanks the app
      // (ErrorBoundary is the backstop, this is the first line).
      let s: string = DICTS[lang][key] ?? DICTS.de[key] ?? key;
      if (params) {
        for (const [k, v] of Object.entries(params)) {
          s = s.replaceAll(`{${k}}`, String(v));
        }
      }
      return s;
    },
    [lang],
  );

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    localStorage.setItem("dokumente.lang", l);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("dokumente.theme", dark ? "dark" : "light");
  }, [dark]);

  const refresh = useCallback(() => setRefreshTick((tick) => tick + 1), []);

  // Load cached remote data immediately (offline-first), then resolve the
  // pairing status. The pull lives in a separate effect below: this one
  // calls setPaired, which would otherwise re-trigger its own effect and
  // fire a second full pull on every startup.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cached = await ipc.remoteData();
        if (cancelled) return;
        setUpdates(cached);
        setSyncError(null);
      } catch {
        // Cache miss or corruption — ignore, will pull if paired.
      }

      // A quarantined store starts the app on a fresh empty library — the
      // data loss must banner, never pass as "no documents yet".
      try {
        const q = await ipc.quarantineStatus();
        if (!cancelled && q) setQuarantine(q);
      } catch {
        // Old backend without the command — ignore.
      }

      const status = await ipc.pairedStatus().catch((err: unknown) => {
        // Keychain/DB failure must surface as a sync error, never as an
        // unhandled rejection that leaves `paired` stale-false.
        if (cancelled) return null;
        setSyncError(String(err));
        return null;
      });
      if (cancelled || status === null) return;
      setPaired(status.paired);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshTick]);

  // Pull whenever pairing is (or becomes) active: already-paired startup
  // (via the status effect above), fresh pairing from Settings, or manual
  // refresh. Exactly one pull per trigger — this effect never writes
  // `paired` itself.
  useEffect(() => {
    if (!paired) return;
    let cancelled = false;
    (async () => {
      try {
        const fresh = await ipc.syncPull();
        if (cancelled) return;
        setUpdates(fresh.data);
        setResynced(fresh.resynced);
        setSyncError(null);
      } catch (err) {
        if (cancelled) return;
        setSyncError(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [paired, refreshTick]);

  // Memoized: rebuilt every render, this object changed identity on every
  // keystroke in any page and defeated memoization in every child.
  const syncState: SyncState = useMemo(
    () => ({ paired, updates, syncError, refresh }),
    [paired, updates, syncError, refresh],
  );

  return (
    <LangContext.Provider value={{ lang, setLang, t }}>
      <div className="flex h-screen overflow-hidden">
        {/* Sidebar */}
        <nav
          className="flex w-52 shrink-0 flex-col border-r px-3 py-5"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="mb-8 px-2">
            <h1 className="font-serif text-xl">Papierkram</h1>
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              {paired ? t("app.paired") : t("app.notPaired")}
              {syncError && (
                <span
                  className="ml-1 text-red-500"
                  title={syncError}
                >
                  ⚠
                </span>
              )}
            </p>
          </div>
          {NAV.map((item) => (
            <button
              key={item.id}
              onClick={() => setPage(item.id)}
              className="mb-1 flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm"
              style={{
                background: page === item.id ? "var(--surface)" : "transparent",
                fontWeight: page === item.id ? 600 : 400,
                border:
                  page === item.id
                    ? "1px solid var(--border)"
                    : "1px solid transparent",
              }}
            >
              <span style={{ color: "var(--accent)" }}>{item.icon}</span>
              {t(item.label as keyof typeof DICTS.de)}
            </button>
          ))}
          <button
            onClick={() => setDark((d) => !d)}
            className="rounded-lg px-3 py-2 text-left text-sm"
            style={{ border: "1px solid var(--border)", cursor: "pointer" }}
          >
            {dark ? t("app.themeLight") : t("app.themeDark")}
          </button>
          <div className="mt-2 flex gap-1">
            {(Object.keys(LANG_LABELS) as Lang[]).map((l) => (
              <button
                key={l}
                onClick={() => setLang(l)}
                className="flex-1 rounded-lg py-1 text-xs"
                style={{
                  cursor: "pointer",
                  border: "1px solid var(--border)",
                  fontWeight: lang === l ? 700 : 400,
                  color: lang === l ? "var(--accent)" : "var(--text-muted)",
                }}
              >
                {LANG_LABELS[l]}
              </button>
            ))}
          </div>
        </nav>

        {/* Content */}
        <main className="flex-1 overflow-y-auto px-10 py-8">
          {quarantine && (
            <div
              className="card mb-6 p-4 text-sm"
              style={{ color: "#dc2626" }}
              role="alert"
            >
              <strong>{t("app.quarantined")}</strong>
              <div className="mt-1">
                {t("app.quarantinedBody", { path: quarantine })}
              </div>
            </div>
          )}
          {resynced && (
            <div
              className="card mb-6 p-4 text-sm"
              style={{ color: "#ca8a04" }}
              role="status"
            >
              {t("app.resynced")}
            </div>
          )}
          {page === "dashboard" && <Dashboard sync={syncState} goTo={setPage} />}
          {page === "documents" && <DocumentsPage sync={syncState} />}
          {page === "calendar" && <CalendarPage sync={syncState} />}
          {page === "tasks" && <TasksPage sync={syncState} goTo={setPage} />}
          {page === "chat" && <ChatPage turns={chatTurns} setTurns={setChatTurns} />}
          {page === "settings" && <SettingsPage onPairedChange={setPaired} onSynced={refresh} />}
        </main>
      </div>
    </LangContext.Provider>
  );
}
