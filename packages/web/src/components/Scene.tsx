import { useEffect, useRef, useState } from "react";
import type { CheckResult } from "@pf2e/shared";
import { FeatherIcon, ArrowRightIcon } from "./icons.js";
import { RollMedallion } from "./RollMedallion.js";

export type LogItem =
  | { kind: "narration"; text: string }
  | { kind: "player"; text: string }
  | { kind: "check"; result: CheckResult };

const PHASE_LABEL: Record<"rules" | "narrative", string> = {
  rules: "Consulting the rules…",
  narrative: "Narrating…",
};

interface Props {
  log: LogItem[];
  busy: boolean;
  phase: "rules" | "narrative" | null;
  onSend: (text: string) => void;
}

export function Scene({ log, busy, phase, onSend }: Props) {
  const [input, setInput] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  // Auto-scroll: scroll the log container (NOT scrollIntoView — it breaks the app).
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, busy, phase]);

  function submit() {
    const text = input.trim();
    if (!text || busy) return;
    onSend(text);
    setInput("");
  }

  const firstNarr = log.findIndex((i) => i.kind === "narration");

  return (
    <section className="scene">
      <div className="log" ref={logRef}>
        <div className="narr">
          {log.map((item, i) => (
            <LogRow key={i} item={item} dropCap={i === firstNarr} />
          ))}
          {busy && (
            <div className="typing">
              <span className="dots">
                <i />
                <i />
                <i />
              </span>
              {phase ? PHASE_LABEL[phase] : "The GM is narrating…"}
            </div>
          )}
        </div>
      </div>

      <div className="composer">
        <FeatherIcon size={18} />
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="What do you do?"
          rows={1}
          disabled={busy}
          aria-label="Your action"
        />
        <button className="btn-act" onClick={submit} disabled={busy || input.trim().length === 0}>
          Act <ArrowRightIcon size={15} style={{ verticalAlign: "-2px" }} />
        </button>
      </div>
    </section>
  );
}

function LogRow({ item, dropCap }: { item: LogItem; dropCap: boolean }) {
  if (item.kind === "player") {
    return <div className="row player">{item.text}</div>;
  }
  if (item.kind === "narration") {
    return <div className={`row narration${dropCap ? " first" : ""}`}>{item.text}</div>;
  }
  return (
    <div className="row rollrow">
      <RollMedallion result={item.result} />
    </div>
  );
}
