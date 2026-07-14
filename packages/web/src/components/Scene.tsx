import { useEffect, useRef, useState } from "react";
import type { CheckResult, Combat } from "@pf2e/shared";
import { ScribeIndicator, type ScribeState } from "../brain/ScribeIndicator.js";
import { CombatPanel } from "./CombatPanel.js";
import { FeatherIcon, ArrowRightIcon } from "./icons.js";
import { RollMedallion } from "./RollMedallion.js";
import type { SceneImagesState } from "./useSceneImages.js";

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
  combat: Combat | null;
  onSend: (text: string) => void;
  scribe: ScribeState;
  sceneImages: SceneImagesState;
  onIllustrate: (key: string, narration: string) => void;
}

export function Scene({
  log,
  busy,
  phase,
  combat,
  onSend,
  scribe,
  sceneImages,
  onIllustrate,
}: Props) {
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
      {combat?.active && <CombatPanel combat={combat} />}
      <div className="log" ref={logRef}>
        <div className="narr">
          {log.map((item, i) => (
            <LogRow
              key={i}
              item={item}
              dropCap={i === firstNarr}
              imageKey={`n${i}`}
              turnBusy={busy}
              sceneImages={sceneImages}
              onIllustrate={onIllustrate}
            />
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

      <div className="composer-row">
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
        <ScribeIndicator scribe={scribe} />
      </div>
    </section>
  );
}

interface LogRowProps {
  item: LogItem;
  dropCap: boolean;
  imageKey: string;
  turnBusy: boolean;
  sceneImages: SceneImagesState;
  onIllustrate: (key: string, narration: string) => void;
}

function LogRow({ item, dropCap, imageKey, turnBusy, sceneImages, onIllustrate }: LogRowProps) {
  if (item.kind === "player") {
    return <div className="row player">{item.text}</div>;
  }
  if (item.kind === "narration") {
    const { images, activeKey, error } = sceneImages;
    const url = images[imageKey];
    const painting = activeKey === imageKey;
    const rowError = error && error.key === imageKey ? error.message : null;
    return (
      <div className={`row narration${dropCap ? " first" : ""}`}>
        {item.text}
        {url && (
          <a href={url} target="_blank" rel="noreferrer" className="scene-img-link">
            <img className="scene-img" src={url} alt="Illustration of this scene" />
          </a>
        )}
        {painting && (
          <div className="scene-img-loading" role="status">
            <span className="dots">
              <i />
              <i />
              <i />
            </span>
            Painting the scene… (the GM sets down the dice for a minute)
          </div>
        )}
        {rowError && <div className="scene-img-error">{rowError}</div>}
        {!url && !painting && !turnBusy && activeKey === null && (
          <button
            className="illus-btn"
            onClick={() => onIllustrate(imageKey, item.text)}
            title="Generate an illustration of this scene (local, ~1 min)"
          >
            <BrushIcon /> Illustrate scene
          </button>
        )}
      </div>
    );
  }
  return (
    <div className="row rollrow">
      <RollMedallion result={item.result} />
    </div>
  );
}

function BrushIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path d="M20 3c-3 1-8.5 5.5-11 9l3 3c3.5-2.5 8-8 9-11l-1-1z" />
      <path d="M9 12c-2.5.5-4 2-4.5 4.5C4.2 18 3.5 19 2.5 19.5c1.5 1.5 4.5 2 6.5.5 1.5-1.2 2-2.5 2-4" />
    </svg>
  );
}
