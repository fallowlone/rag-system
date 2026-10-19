import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ipc } from "../ipc";
import { useI18n } from "../i18n";
import { Translatable } from "../translate-ui";
import type { ModelStatus, QualityFlag } from "../types";

interface Proposal {
  code: string;
  displayCode: string;
  secret: string;
  expiresAt: number;
}

function SyncUploadCheckbox({
  checked,
  onToggle,
  label,
  className = "",
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      onClick={onToggle}
      className={`flex cursor-pointer items-center gap-2 text-left text-sm ${className}`}
    >
      <span
        className="flex h-[18px] w-[18px] items-center justify-center text-xs"
        style={{
          borderRadius: 4,
          border: checked ? "1px solid var(--accent)" : "1px solid var(--border)",
          background: checked ? "var(--accent)" : "transparent",
          color: "#fff",
        }}
      >
        {checked ? "✓" : ""}
      </span>
      {label}
    </button>
  );
}

export function SettingsPage(props: {
  onPairedChange: (paired: boolean) => void;
  onSynced: () => void;
}) {
  const { t } = useI18n();
  const [deviceName, setDeviceName] = useState("");
  const [paired, setPaired] = useState(false);
  const [pairedName, setPairedName] = useState<string | null>(null);
  const [syncUpload, setSyncUpload] = useState(true);
  // Opt-in server-side image scan (default OFF — raw bytes stay on device
  // unless the user explicitly allows the upload).
  const [serverScan, setServerScan] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(0);
  // Set when propose retries are exhausted: the card would otherwise sit on
  // "…" with no countdown and no recovery except remounting Settings.
  const [pairDead, setPairDead] = useState(false);
  const [pairRetryTick, setPairRetryTick] = useState(0);
  const [model, setModel] = useState<ModelStatus | null>(null);
  const [message, setMessage] = useState<string>("");
  const [qualityFlags, setQualityFlags] = useState<QualityFlag[]>([]);
  const [downloading, setDownloading] = useState(false);
  const [showModelPicker, setShowModelPicker] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [progress, setProgress] = useState<{ downloaded: number; total: number | null } | null>(null);
  const runId = useRef(0);
  // Latest device name for the poll loop: the proposal is made once on
  // mount (re-proposing on every keystroke would invalidate the shown
  // code), while the CURRENT name still goes out with each poll.
  const deviceNameRef = useRef(deviceName);
  deviceNameRef.current = deviceName;
  // Same for the translator: the pairing loop must speak the CURRENT UI
  // language (a mid-pairing language switch must not leave stale copy).
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    ipc.pairingDetails()
      .then((d) => {
        setPaired(d.paired);
        props.onPairedChange(d.paired);
        if (d.deviceName) {
          setDeviceName(d.deviceName);
          setPairedName(d.deviceName);
        }
        setSyncUpload(d.syncUploadEnabled);
        setServerScan(d.serverScanEnabled);
      })
      .catch(() => undefined);
    ipc.modelStatus().then(setModel).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reverse-pairing loop: propose a code once while unpaired, poll every
  // 2s, regenerate on expiry. The device name is read live per poll, so
  // typing it never invalidates the shown code.
  useEffect(() => {
    if (paired) return;
    const id = ++runId.current;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let tickTimer: ReturnType<typeof setInterval> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    // Capped propose retries with backoff: an unreachable backend must not
    // spin IPC+network attempts every 5s forever while Settings stays open.
    const MAX_PROPOSE_ATTEMPTS = 5;
    let proposeAttempts = 0;
    const alive = () => runId.current === id;

    const stop = () => {
      if (pollTimer) clearInterval(pollTimer);
      if (tickTimer) clearInterval(tickTimer);
      if (retryTimer) clearTimeout(retryTimer);
      pollTimer = tickTimer = undefined;
      retryTimer = undefined;
    };

    const pollOnce = async (code: string, secret: string) => {
      try {
        const name = deviceNameRef.current.trim() || "Mac";
        const r = await ipc.pairPoll(code, secret, name);
        if (!alive()) return;
        if (r.claimed) {
          stop();
          setProposal(null);
          setPaired(true);
          props.onPairedChange(true);
          setPairedName(name);
          setMessage(tRef.current("set.paired"));
        }
      } catch {
        // Transient network error — keep polling until expiry.
      }
    };

    const propose = async (): Promise<void> => {
      const name = deviceNameRef.current.trim() || "Mac";
      let p;
      try {
        p = await ipc.pairPropose(name);
      } catch (e) {
        if (!alive()) return;
        proposeAttempts += 1;
        setMessage(tRef.current("set.pairError", { error: String(e) }));
        if (proposeAttempts >= MAX_PROPOSE_ATTEMPTS) {
          setPairDead(true);
          return;
        }
        const backoffMs = 5000 * 2 ** (proposeAttempts - 1);
        retryTimer = setTimeout(() => {
          if (alive()) void propose();
        }, backoffMs);
        return;
      }
      if (!alive()) return;
      proposeAttempts = 0;
      setPairDead(false);
      const expiresAt = Date.now() + p.expiresIn * 1000;
      setProposal({
        code: p.code,
        displayCode: p.displayCode,
        secret: p.secret,
        expiresAt,
      });
      setSecondsLeft(p.expiresIn);
      pollTimer = setInterval(() => void pollOnce(p.code, p.secret), 2000);
      // Wall-clock countdown so background throttling can't stall it.
      tickTimer = setInterval(() => {
        if (!alive()) return;
        const left = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
        setSecondsLeft(left);
        if (left <= 0) {
          stop();
          if (alive()) void propose();
        }
      }, 1000);
    };

    const timer = setTimeout(() => void propose(), 400);
    return () => {
      runId.current++;
      clearTimeout(timer);
      stop();
    };
    // Propose once per unpaired mount: re-proposing on every deviceName
    // keystroke would invalidate the shown code mid-typing (the name still
    // travels with each poll via deviceNameRef).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paired, pairRetryTick]);

  const retryPairing = () => {
    setPairDead(false);
    setMessage("");
    setPairRetryTick((n) => n + 1);
  };

  const copyCode = async () => {
    if (!proposal) return;
    try {
      await navigator.clipboard.writeText(proposal.displayCode);
      setMessage(t("set.copied"));
    } catch (e) {
      setMessage(t("set.pairError", { error: String(e) }));
    }
  };

  const openTelegram = async () => {
    const command = `/pair ${proposal?.displayCode ?? ""}`;
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      // Clipboard is best-effort; the deep link still helps.
    }
    try {
      const { botUsername } = await ipc.botUsername();
      if (botUsername) {
        await openUrl(`https://t.me/${botUsername}`);
        return;
      }
    } catch {
      // Fall through to the copy-paste hint below.
    }
    setMessage(t("set.noBotUsername"));
  };

  const unpair = async () => {
    setMessage("");
    try {
      await ipc.unpairDevice();
    } catch (e) {
      setMessage(t("set.pairError", { error: String(e) }));
      return;
    }
    setPaired(false);
    props.onPairedChange(false);
    setProposal(null);
  };

  const toggleSyncUpload = async () => {
    const next = !syncUpload;
    try {
      await ipc.setSyncUpload(next);
      setSyncUpload(next);
    } catch (e) {
      setMessage(t("set.pairError", { error: String(e) }));
    }
  };

  const toggleServerScan = async () => {
    const next = !serverScan;
    try {
      await ipc.setServerScan(next);
      setServerScan(next);
    } catch (e) {
      setMessage(t("set.pairError", { error: String(e) }));
    }
  };

  const syncNow = async () => {
    if (syncing) return;
    setSyncing(true);
    setMessage("");
    setQualityFlags([]);
    try {
      const r = await ipc.syncNow();
      setMessage(t("set.syncDone", { sent: r.sent, retried: r.retried, parked: r.parked }));
      setQualityFlags(r.quality_flags ?? []);
      // syncNow only pushes — pull + refresh so Tasks/Calendar/Dashboard
      // show the new server state instead of going stale.
      props.onSynced();
    } catch (e) {
      setMessage(String(e));
    } finally {
      setSyncing(false);
    }
  };

  const downloadModel = async (small: boolean) => {
    setDownloading(true);
    setProgress(null);
    setMessage(t("set.downloading"));
    // Per-chunk progress callbacks re-render for a multi-GB transfer —
    // throttle to ~4 Hz, always letting the final (complete) update through.
    let lastProgressAt = 0;
    try {
      const r = await ipc.downloadModel(small, (downloaded, total) => {
        const now = Date.now();
        const complete = total !== null && downloaded >= total;
        if (!complete && now - lastProgressAt < 250) return;
        lastProgressAt = now;
        setProgress({ downloaded, total });
      });
      const shortHash = r.sha256?.slice(0, 16) ?? "";
      setMessage(
        r.status === "verified"
          ? t("set.dlVerified")
          : r.status === "upstream_verified"
            ? // Not pinned in code, but the bytes matched the digest the
              // origin published for them — a real check, distinct from
              // accepting whatever arrived.
              t("set.dlUpstream", { hash: shortHash })
            : t("set.dlUnpinned", { hash: shortHash }),
      );
      ipc.modelStatus(small).then(setModel).catch(() => undefined);
      setShowModelPicker(false);
    } catch (e) {
      setMessage(String(e));
    } finally {
      setDownloading(false);
      setProgress(null);
    }
  };

  return (
    <div className="mx-auto max-w-xl">
      <h1 className="font-serif text-3xl">{t("set.title")}</h1>
      <p className="mt-1 mb-8 text-sm" style={{ color: "var(--text-muted)" }}>
        {t("set.subtitle")}
      </p>

      {message && (
        <p className="card mb-6 p-4 text-sm" style={{ color: "var(--accent)" }}>
          {message}
        </p>
      )}

      {qualityFlags.length > 0 && (
        <div className="card mb-6 p-4 text-sm">
          <strong>{t("set.qualityTitle")}</strong>
          <ul className="mt-2 list-disc pl-5">
            {qualityFlags.map((flag) => (
              <li key={flag.documentId}>
                {t("set.qualityDoc", { score: flag.score })}
                <ul className="list-disc pl-5" style={{ color: "var(--text-muted)" }}>
                  {flag.issues.map((issue) => (
                    <li key={issue.code}>
                      <Translatable text={issue.message} />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="card mb-6 p-6">
        {!paired && (
          <>
            <div className="flex gap-6">
              <div className="flex-1">
                <h2 className="mb-1 font-serif text-lg">{t("set.pairViaTitle")}</h2>
                <p className="mb-4 text-xs" style={{ color: "var(--text-muted)" }}>
                  {t("set.pairViaBody")}
                </p>
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  {t("set.pairPrivacyPre")}
                  <a href="#privacy" style={{ color: "var(--accent)" }}>
                    {t("set.pairPrivacyLink")}
                  </a>
                  {t("set.pairPrivacyPost")}
                </p>
              </div>
              <div className="w-px self-stretch" style={{ background: "var(--border)" }} />
              <div className="flex-1">
                <div
                  className="card px-4 py-3 text-center font-mono text-2xl"
                  style={{ letterSpacing: "0.12em" }}
                >
                  {proposal?.displayCode ?? "…"}
                </div>
                {/* Countdown only once a proposal exists — before the first
                    propose the counter would show a bogus "0s". */}
                {proposal && (
                  <p
                    className="mt-2 text-center text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {t("set.codeExpiresPre")}
                    <span style={{ color: "var(--accent)", fontWeight: 600 }}>
                      {secondsLeft}s
                    </span>
                    {t("set.codeExpiresPost")}
                  </p>
                )}
                {pairDead && !paired && (
                  <button
                    className="btn btn-primary mt-2 w-full"
                    onClick={retryPairing}
                  >
                    {t("set.pairRetry")}
                  </button>
                )}
                <div className="mt-3 flex gap-2">
                  <button
                    className="btn btn-primary flex-1 text-xs"
                    onClick={() => void copyCode()}
                    disabled={!proposal}
                  >
                    ⧉ {t("set.copyCode")}
                  </button>
                  <button
                    className="btn btn-ghost flex-1 text-xs"
                    onClick={() => void openTelegram()}
                    disabled={!proposal}
                  >
                    ➤ {t("set.openTelegram")}
                  </button>
                </div>
              </div>
            </div>
            <div className="my-6 border-t" style={{ borderColor: "var(--border)" }} />
            <label
              className="mb-1.5 block text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              {t("set.deviceNameLabel")}
            </label>
            <input
              className="card w-full px-4 py-2.5 text-sm outline-none"
              placeholder={t("set.devicePh")}
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
            />
            <SyncUploadCheckbox
              checked={syncUpload}
              onToggle={() => void toggleSyncUpload()}
              label={t("set.allowSync")}
              className="mt-3"
            />
          </>
        )}

        {paired && (
          <>
            <div className="flex items-center justify-between">
              <span className="text-sm">
                <span style={{ color: "#059669" }}>✓</span>{" "}
                {t("set.pairedAs", { name: pairedName ?? (deviceName.trim() || "Mac") })}
              </span>
              <button
                className="text-sm"
                style={{ color: "var(--accent)", cursor: "pointer" }}
                onClick={() => void unpair()}
              >
                {t("set.unpair")}
              </button>
            </div>
            <div
              className="my-4 border-t"
              style={{ borderColor: "var(--border)" }}
            />
            <SyncUploadCheckbox
              checked={syncUpload}
              onToggle={() => void toggleSyncUpload()}
              label={t("set.allowSync")}
            />
            <SyncUploadCheckbox
              checked={serverScan}
              onToggle={() => void toggleServerScan()}
              label={t("set.serverScan")}
              className="mt-3"
            />
            <p
              className="mt-1 text-xs"
              style={{ color: "var(--text-muted)" }}
            >
              {t("set.serverScanDesc")}
            </p>
            <div className="mt-4 flex justify-end">
              <button
                className="btn btn-ghost text-xs"
                disabled={syncing}
                onClick={() => void syncNow()}
              >
                {t("set.syncNow")}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="card mb-6 p-6">
        <h2 className="mb-1 font-serif text-lg">{t("set.modelTitle")}</h2>
        <p className="mb-4 text-xs" style={{ color: "var(--text-muted)" }}>
          {t("set.modelSub")}
        </p>
        {model && (
          <p className="mb-3 text-sm">
            {model.downloaded ? "✓" : "○"} {model.name}{" "}
            <span style={{ color: "var(--text-muted)" }}>
              ({(model.size_bytes / 1e9).toFixed(1)} GB)
            </span>
          </p>
        )}
        {/* Hiding these once ANY model existed made the other size
            unreachable without clearing the cache by hand — on a machine
            that failed the 12 GB gate, the small model was exactly what the
            user needed and could no longer ask for. */}
        {model?.downloaded && !showModelPicker && !downloading && (
          <button
            className="btn btn-ghost text-xs"
            onClick={() => setShowModelPicker(true)}
          >
            {t("set.modelSwitch")}
          </button>
        )}
        {(!model?.downloaded || showModelPicker || downloading) && (
          <div className="space-y-3">
            <div className="flex gap-2">
              <button className="btn btn-primary" disabled={downloading} onClick={() => downloadModel(false)}>
                {t("set.modelStandard")}
              </button>
              <button className="btn btn-ghost" disabled={downloading} onClick={() => downloadModel(true)}>
                {t("set.modelSmall")}
              </button>
            </div>
            {downloading && progress && (
              <ProgressBar downloaded={progress.downloaded} total={progress.total} />
            )}
          </div>
        )}
      </section>

      <section className="card p-6" id="privacy">
        <h2 className="mb-1 font-serif text-lg">{t("set.privacyTitle")}</h2>
        <ul className="list-disc pl-5 text-sm" style={{ color: "var(--text-muted)" }}>
          <li>{t("set.privacy1")}</li>
          <li>{t("set.privacy2")}</li>
          <li>{t("set.privacy3")}</li>
        </ul>
      </section>
    </div>
  );
}

function formatBytes(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1e9).toFixed(2)} GB`;
  if (n >= 1_000_000) return `${(n / 1e6).toFixed(1)} MB`;
  if (n >= 1_000) return `${(n / 1e3).toFixed(0)} KB`;
  return `${n} B`;
}

function ProgressBar(props: { downloaded: number; total: number | null }) {
  const pct = props.total ? Math.min(100, Math.round((props.downloaded / props.total) * 100)) : null;
  return (
    <div>
      <div
        className="h-2 w-full overflow-hidden rounded-full"
        style={{ background: "var(--border)" }}
      >
        <div
          className="h-full rounded-full transition-all"
          style={{
            width: pct !== null ? `${pct}%` : "30%",
            background: "var(--accent)",
            // Indeterminate shimmer when the server did not send Content-Length.
            animation: pct === null ? "dl-shimmer 1.5s ease-in-out infinite" : undefined,
          }}
        />
      </div>
      <p className="mt-1 text-xs" style={{ color: "var(--text-muted)" }}>
        {formatBytes(props.downloaded)}
        {props.total ? ` / ${formatBytes(props.total)}` : ""}
        {pct !== null ? ` — ${pct}%` : ""}
      </p>
    </div>
  );
}
