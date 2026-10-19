import React from "react";

interface State {
  error: string | null;
}

/**
 * Last-resort render guard: without this, any render throw (a missing i18n
 * key, a malformed server row) blanks the whole app until restart with no
 * explanation. Deliberately uses no i18n — the crash may BE the i18n layer.
 */
export class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  State
> {
  state: State = { error: null };

  static getDerivedStateFromError(err: unknown): State {
    return { error: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(): void {
    // Logged to the webview console for diagnostics (no backend call —
    // the app may be offline exactly when this matters).
    console.error("[Papierkram] render crashed:", this.state.error);
  }

  render(): React.ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div style={{ padding: 40, fontFamily: "system-ui, sans-serif" }}>
        <h1>Etwas ist schiefgelaufen / Something went wrong</h1>
        <p style={{ color: "#666" }}>
          Die Ansicht ist abgestürzt. Ein Neuladen behebt das meist — deine
          Dokumente sind lokal gespeichert und gehen nicht verloren.
        </p>
        <pre
          style={{
            background: "#f4f4f4",
            padding: 12,
            borderRadius: 8,
            overflow: "auto",
          }}
        >
          {this.state.error}
        </pre>
        <button onClick={() => window.location.reload()}>Neu laden</button>
      </div>
    );
  }
}
