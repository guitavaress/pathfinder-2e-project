import { useEffect, useMemo, useRef, useState } from "react";
import type { Adjudicated, CheckResult, Combat, TurnRef } from "@pf2e/shared";
import type { PaletteEntry } from "../api.js";
import { ScribeIndicator, type ScribeState } from "../brain/ScribeIndicator.js";
import { AbilityPalette } from "./AbilityPalette.js";
import { CombatPanel } from "./CombatPanel.js";
import { FeatherIcon, ArrowRightIcon } from "./icons.js";
import { RollMedallion } from "./RollMedallion.js";

export type LogItem =
  | { kind: "narration"; text: string }
  | { kind: "player"; text: string }
  | { kind: "check"; result: CheckResult }
  | { kind: "adjudicated"; adjudicated: Adjudicated };

const PHASE_LABEL: Record<"rules" | "narrative", string> = {
  rules: "Consulting the rules…",
  narrative: "Narrating…",
};

interface Props {
  log: LogItem[];
  busy: boolean;
  phase: "rules" | "narrative" | null;
  combat: Combat | null;
  onSend: (text: string, refs: TurnRef[]) => void;
  scribe: ScribeState;
  /** O que a ficha nomeia, para o `@`. Lista vazia = campo de texto de sempre. */
  palette: PaletteEntry[];
}

/** Quantas opções a lista mostra por vez — o resto se filtra digitando. */
const MENU_LIMIT = 8;

/**
 * O `@` aberto no ponto do cursor: onde começa e o que já foi digitado.
 *
 * O nome pode ter espaços ("Shake It Off"), então o trecho não termina no
 * primeiro branco — termina na quebra de linha ou quando nada mais casa.
 */
function activeToken(text: string, caret: number): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at < 0) return null;
  const query = upto.slice(at + 1);
  if (query.includes("\n") || query.length > 40) return null;
  return { start: at, query };
}

export function Scene({ log, busy, phase, combat, onSend, scribe, palette }: Props) {
  const [input, setInput] = useState("");
  const [refs, setRefs] = useState<TurnRef[]>([]);
  const [token, setToken] = useState<{ start: number; query: string } | null>(null);
  const [selected, setSelected] = useState(0);
  const logRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // Auto-scroll: scroll the log container (NOT scrollIntoView — it breaks the app).
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log, busy, phase]);

  const matches = useMemo(() => {
    if (!token) return [];
    const q = token.query.toLowerCase().trim();
    return palette.filter((e) => e.name.toLowerCase().includes(q)).slice(0, MENU_LIMIT);
  }, [token, palette]);
  const menuOpen = token !== null && matches.length > 0;

  function sync(text: string, caret: number): void {
    setInput(text);
    setToken(activeToken(text, caret));
    setSelected(0);
  }

  /** Troca o `@trecho` pelo nome e guarda a referência do documento. */
  function pick(entry: PaletteEntry): void {
    if (!token) return;
    const before = input.slice(0, token.start);
    const after = input.slice(token.start + 1 + token.query.length);
    const text = `${before}${entry.name}${after}`;
    setInput(text);
    setRefs((prev) => [
      ...prev.filter((r) => r.name.toLowerCase() !== entry.name.toLowerCase()),
      { name: entry.name, category: entry.category, ...(entry.uuid ? { uuid: entry.uuid } : {}) },
    ]);
    setToken(null);
    const caret = before.length + entry.name.length;
    requestAnimationFrame(() => {
      const el = boxRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  function submit() {
    const text = input.trim();
    if (!text || busy) return;
    // Só viaja a referência do que SOBROU no texto: o jogador pode escolher
    // pela paleta e depois apagar. Referência de nome que não está na frase
    // seria a engine desambiguando uma consulta que ninguém fez.
    const lower = text.toLowerCase();
    onSend(
      text,
      refs.filter((r) => lower.includes(r.name.toLowerCase())),
    );
    setInput("");
    setRefs([]);
    setToken(null);
  }

  const firstNarr = log.findIndex((i) => i.kind === "narration");

  return (
    <section className="scene">
      {combat?.active && <CombatPanel combat={combat} />}
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

      <div className="composer-row">
        <div className="composer">
          {menuOpen && (
            <AbilityPalette
              entries={matches}
              selected={selected}
              onPick={pick}
              onHover={setSelected}
            />
          )}
          <FeatherIcon size={18} />
          <textarea
            ref={boxRef}
            value={input}
            onChange={(e) => sync(e.target.value, e.target.selectionStart ?? e.target.value.length)}
            onClick={(e) => {
              const el = e.currentTarget;
              setToken(activeToken(el.value, el.selectionStart ?? 0));
            }}
            onBlur={() => setToken(null)}
            onKeyDown={(e) => {
              // Com a lista aberta as setas e o Enter são DELA. Sem isto,
              // escolher uma habilidade mandaria o turno junto.
              if (menuOpen) {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSelected((i) => (i + 1) % matches.length);
                  return;
                }
                if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSelected((i) => (i - 1 + matches.length) % matches.length);
                  return;
                }
                if (e.key === "Enter" || e.key === "Tab") {
                  e.preventDefault();
                  pick(matches[selected]!);
                  return;
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  setToken(null);
                  return;
                }
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="What do you do?  (@ for your abilities)"
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

function LogRow({ item, dropCap }: { item: LogItem; dropCap: boolean }) {
  if (item.kind === "player") {
    return <div className="row player">{item.text}</div>;
  }
  if (item.kind === "narration") {
    return <div className={`row narration${dropCap ? " first" : ""}`}>{item.text}</div>;
  }
  if (item.kind === "adjudicated") {
    // Discreto de propósito: é meta-informação honesta, não um evento da cena.
    // O jogador precisa saber que aquilo foi NARRADO e não enforced — sem que
    // o aviso compita com a narrativa.
    return (
      <div className="row adjudicated" title={item.adjudicated.reason}>
        <span className="adjudicated-name">{item.adjudicated.name}</span>
        <span className="adjudicated-note">narrado, não automatizado pela engine</span>
      </div>
    );
  }
  return (
    <div className="row rollrow">
      <RollMedallion result={item.result} />
    </div>
  );
}
