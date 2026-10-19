import { useRef, useState } from "react";
import { ipc } from "../ipc";
import { useI18n } from "../i18n";
import type { TKey } from "../i18n";

interface Message {
  role: "user" | "assistant";
  text: string;
}

export type { Message as ChatMessage };

/** Backend Zod cap mirror (POST /app/v1/chat, Rust validate_ask): fail fast
 *  client-side with a counter instead of paying an IPC round trip for a
 *  guaranteed 400. */
const CHAT_MAX_CHARS = 4000;

type BriefLetter = "jobcenter" | "auslander" | "insurance" | "landlord" | "other";
type BriefNeed = "explain" | "reply" | "deadline" | "legality";
type BriefTone = "neutral" | "firm" | "polite";

const LETTERS: BriefLetter[] = ["jobcenter", "auslander", "insurance", "landlord", "other"];
const NEEDS: BriefNeed[] = ["explain", "reply", "deadline", "legality"];
const TONES: BriefTone[] = ["neutral", "firm", "polite"];

const LETTER_LABEL: Record<BriefLetter, TKey> = {
  jobcenter: "brief.letter.jobcenter",
  auslander: "brief.letter.auslander",
  insurance: "brief.letter.insurance",
  landlord: "brief.letter.landlord",
  other: "brief.letter.other",
};

const NEED_LABEL: Record<BriefNeed, TKey> = {
  explain: "brief.need.explain",
  reply: "brief.need.reply",
  deadline: "brief.need.deadline",
  legality: "brief.need.legality",
};

const TONE_LABEL: Record<BriefTone, TKey> = {
  neutral: "brief.tone.neutral",
  firm: "brief.tone.firm",
  polite: "brief.tone.polite",
};

const LETTER_NAME: Record<BriefLetter, TKey> = {
  jobcenter: "brief.letterName.jobcenter",
  auslander: "brief.letterName.auslander",
  insurance: "brief.letterName.insurance",
  landlord: "brief.letterName.landlord",
  other: "brief.letterName.other",
};

const NEED_QUESTION: Record<BriefNeed, TKey> = {
  explain: "brief.q.explain",
  reply: "brief.q.reply",
  deadline: "brief.q.deadline",
  legality: "brief.q.legality",
};

const TONE_SUFFIX: Record<BriefTone, TKey> = {
  neutral: "brief.toneSuffix.neutral",
  firm: "brief.toneSuffix.firm",
  polite: "brief.toneSuffix.polite",
};

export function ChatPage({
  turns,
  setTurns,
}: {
  turns: Message[];
  setTurns: React.Dispatch<React.SetStateAction<Message[]>>;
}) {
  const { t, lang } = useI18n();
  // The greeting is derived at render time so a language switch re-translates
  // it; only real conversation turns live in state (lifted to App so
  // navigating away no longer wipes the conversation).
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [letter, setLetter] = useState<BriefLetter | null>(null);
  const [need, setNeed] = useState<BriefNeed | null>(null);
  const [tone, setTone] = useState<BriefTone | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const messages: Message[] = [
    { role: "assistant", text: t("chat.greeting") },
    ...turns,
  ];

  const sendText = async (question: string) => {
    if (!question || loading) return;
    if (question.length > CHAT_MAX_CHARS) {
      setTurns((m) => [
        ...m,
        { role: "user", text: question },
        {
          role: "assistant",
          text: t("chat.tooLong", { max: CHAT_MAX_CHARS }),
        },
      ]);
      setInput("");
      return;
    }
    setInput("");
    setTurns((m) => [...m, { role: "user", text: question }]);
    setLoading(true);
    try {
      const answer = await ipc.chatAsk(question, lang);
      setTurns((m) => [...m, { role: "assistant", text: answer }]);
    } catch (e) {
      // "Not paired" is a state, not a string: ask the backend instead of
      // matching Rust's error wording (which already drifted once).
      let paired = true;
      try {
        paired = (await ipc.pairedStatus()).paired;
      } catch {
        // Status check failed too — fall through to the raw error below.
      }
      setTurns((m) => [
        ...m,
        {
          role: "assistant",
          text: paired
            ? t("chat.errPrefix", { error: String(e) })
            : t("chat.errNotPaired"),
        },
      ]);
    } finally {
      setLoading(false);
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: "smooth" }));
    }
  };

  const send = () => {
    void sendText(input.trim());
  };

  // Brief Builder: turn three taps into the first question, then collapse
  // into the normal chat (it only renders while the conversation is empty).
  const generate = () => {
    const l = letter ?? "other";
    const n = need ?? "explain";
    const tn = tone ?? "neutral";
    const question = `${t(NEED_QUESTION[n], { letter: t(LETTER_NAME[l]) })} ${t(TONE_SUFFIX[tn])}`;
    void sendText(question);
  };

  const showBrief = turns.length === 0 && !loading;

  return (
    <div className="mx-auto flex h-full max-w-2xl flex-col">
      <h1 className="font-serif text-3xl">{t("chat.title")}</h1>
      <p className="mt-1 mb-4 text-sm" style={{ color: "var(--text-muted)" }}>
        {t("chat.subtitle")}
      </p>

      <div className="flex flex-1 flex-col space-y-3 overflow-y-auto pb-4">
        {messages.map((m, i) => (
          <div
            key={i}
            className={`card max-w-[85%] px-4 py-3 text-sm ${m.role === "user" ? "ml-auto" : "mr-auto"}`}
            style={
              m.role === "user"
                ? { background: "color-mix(in srgb, var(--accent) 14%, var(--surface))" }
                : undefined
            }
          >
            <div style={{ whiteSpace: "pre-wrap", userSelect: "text" }}>{m.text}</div>
          </div>
        ))}
        {loading && (
          <div className="card mr-auto max-w-[85%] px-4 py-3 text-sm" style={{ color: "var(--text-muted)" }}>
            {t("chat.thinking")}
          </div>
        )}
        {showBrief && (
          <div className="m-auto w-full max-w-md py-6">
            <div className="card p-6">
              <h2 className="mb-4 text-center font-serif text-xl">{t("brief.title")}</h2>
              <p className="mb-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
                {t("brief.letterLabel")}
              </p>
              <div className="mb-4 flex flex-wrap gap-2">
                {LETTERS.map((l) => (
                  <button
                    key={l}
                    type="button"
                    className={`btn text-xs ${letter === l ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setLetter(l)}
                  >
                    {t(LETTER_LABEL[l])}
                  </button>
                ))}
              </div>
              <p className="mb-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
                {t("brief.needLabel")}
              </p>
              <div className="mb-4 flex flex-wrap gap-2">
                {NEEDS.map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`btn text-xs ${need === n ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setNeed(n)}
                  >
                    {t(NEED_LABEL[n])}
                  </button>
                ))}
              </div>
              <p className="mb-1.5 text-xs" style={{ color: "var(--text-muted)" }}>
                {t("brief.toneLabel")}
              </p>
              <div className="mb-5 flex flex-wrap gap-2">
                {TONES.map((tn) => (
                  <button
                    key={tn}
                    type="button"
                    className={`btn text-xs ${tone === tn ? "btn-primary" : "btn-ghost"}`}
                    onClick={() => setTone(tn)}
                  >
                    {t(TONE_LABEL[tn])}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="btn btn-primary w-full"
                onClick={generate}
              >
                {t("brief.generate")}
              </button>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <form
        className="mt-3 flex gap-2 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <div className="flex flex-1 flex-col">
          <input
            className="card flex-1 px-4 py-2.5 text-sm outline-none"
            placeholder={t("chat.placeholder")}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={loading}
          />
          <span
            className="mt-1 text-right text-xs"
            style={{
              color:
                input.length > CHAT_MAX_CHARS ? "#dc2626" : "var(--text-muted)",
            }}
          >
            {input.length}/{CHAT_MAX_CHARS}
          </span>
        </div>
        <button className="btn btn-primary self-stretch" disabled={loading || !input.trim()}>
          {t("chat.send")}
        </button>
      </form>
    </div>
  );
}
