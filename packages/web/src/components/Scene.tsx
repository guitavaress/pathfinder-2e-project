import { useEffect, useRef, useState } from "react";
import type { CheckResult, DegreeOfSuccess } from "@pf2e/shared";

export type LogItem =
  | { kind: "narration"; text: string }
  | { kind: "player"; text: string }
  | { kind: "check"; result: CheckResult };

const DEGREE_LABEL: Record<DegreeOfSuccess, string> = {
  criticalSuccess: "Sucesso crítico",
  success: "Sucesso",
  failure: "Falha",
  criticalFailure: "Falha crítica",
};

interface Props {
  log: LogItem[];
  busy: boolean;
  phase: "rules" | "narrative" | null;
  onSend: (text: string) => void;
}

const PHASE_LABEL: Record<"rules" | "narrative", string> = {
  rules: "Consultando as regras…",
  narrative: "Narrando…",
};

export function Scene({ log, busy, phase, onSend }: Props) {
  const [input, setInput] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [log]);

  function submit() {
    const text = input.trim();
    if (!text || busy) return;
    onSend(text);
    setInput("");
  }

  return (
    <section className="scene">
      <div className="log">
        {log.map((item, i) => (
          <LogRow key={i} item={item} />
        ))}
        {busy && (
          <div className="typing">
            {phase ? PHASE_LABEL[phase] : "O Mestre está pensando…"}
          </div>
        )}
        <div ref={bottomRef} />
      </div>
      <div className="composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="O que você faz?"
          rows={2}
          disabled={busy}
        />
        <button onClick={submit} disabled={busy || input.trim().length === 0}>
          Agir
        </button>
      </div>
    </section>
  );
}

function LogRow({ item }: { item: LogItem }) {
  if (item.kind === "player") {
    return <div className="row player">{item.text}</div>;
  }
  if (item.kind === "narration") {
    return <div className="row narration">{item.text}</div>;
  }
  const r = item.result;
  return (
    <div className={`row check ${r.degree}`}>
      <span className="check-label">{r.label}</span>
      <span className="check-roll">
        d20: {r.die} {r.modifier >= 0 ? "+" : ""}
        {r.modifier} = <strong>{r.total}</strong> vs DC {r.dc}
      </span>
      <span className="check-degree">{DEGREE_LABEL[r.degree]}</span>
    </div>
  );
}
