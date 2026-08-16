/**
 * Indicador "o escriba anota" (frame 1F): botão circular 40px à direita do
 * composer. Rodando = pena pulsando + dot dourado; concluído = toast ~5s
 * "Anotado: + X · ~ Y"; rejeições = âmbar "ver por quê →" (nunca vermelho —
 * não é erro do jogador). Clique abre a Atividade (#brain/activity).
 *
 * O servidor não empurra o fim do write pass (o SSE fecha no done), então o
 * hook faz polling leve de /brain/activity só na janela pós-turno.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchActivity, type BrainActivityPass } from "./api.js";

export type ScribeStatus = "idle" | "writing" | "done" | "warn";

export interface ScribeState {
  status: ScribeStatus;
  toast: string | null;
}

const POLL_MS = 2500;
const GIVE_UP_MS = 90_000;
const TOAST_MS = 5000;

function summarize(pass: BrainActivityPass): ScribeState {
  if (pass.error) {
    return { status: "warn", toast: "The scribe stumbled — see why →" };
  }
  const parts = pass.applied.slice(0, 3).map((cmd) => {
    const m = /^(CREATE|UPDATE|APPEND)\s+(.+)\.md$/.exec(cmd);
    if (m) return `${m[1] === "CREATE" ? "+" : "~"} ${m[2]}`;
    return `» ${cmd === "TIMELINE" ? "Timeline" : "Journal"}`;
  });
  if (pass.rejected.length > 0) {
    return {
      status: "warn",
      toast: `Anotado com avisos: ${parts.join(" · ") || "nada"} · ${pass.rejected.length} rejeitado — ver por quê →`,
    };
  }
  if (parts.length === 0) {
    return { status: "done", toast: "The scribe saw nothing new." };
  }
  return { status: "done", toast: `Anotado: ${parts.join(" · ")}` };
}

/** Estado do escriba + gatilhos para o App chamar no início/fim de cada turno. */
export function useScribe(): {
  scribe: ScribeState;
  onTurnStart: () => void;
  onTurnDone: () => void;
} {
  const [scribe, setScribe] = useState<ScribeState>({ status: "idle", toast: null });
  const baselineRef = useRef(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const onTurnStart = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    void fetchActivity()
      .then((feed) => {
        baselineRef.current = feed.activity.length;
      })
      .catch(() => {});
  }, []);

  const onTurnDone = useCallback(() => {
    setScribe({ status: "writing", toast: null });
    const started = Date.now();
    let polls = 0;
    const poll = async () => {
      polls += 1;
      try {
        const feed = await fetchActivity();
        if (feed.activity.length > baselineRef.current) {
          baselineRef.current = feed.activity.length;
          const latest = feed.activity[feed.activity.length - 1]!;
          setScribe(summarize(latest));
          timerRef.current = setTimeout(
            () => setScribe((s) => ({ ...s, status: "idle", toast: null })),
            TOAST_MS,
          );
          return;
        }
        // Sem pass rodando nem resultado novo após 2 checks → brain quieto.
        if (!feed.writing && polls > 1) {
          setScribe({ status: "idle", toast: null });
          return;
        }
      } catch {
        setScribe({ status: "idle", toast: null });
        return;
      }
      if (Date.now() - started < GIVE_UP_MS) {
        timerRef.current = setTimeout(() => void poll(), POLL_MS);
      } else {
        setScribe({ status: "idle", toast: null });
      }
    };
    timerRef.current = setTimeout(() => void poll(), 1200);
  }, []);

  return { scribe, onTurnStart, onTurnDone };
}

const LABEL: Record<ScribeStatus, string> = {
  idle: "Open the Memory Grimoire (Activity)",
  writing: "The scribe is writing",
  done: "Memory updated",
  warn: "Memory updated with warnings",
};

export function ScribeIndicator({ scribe }: { scribe: ScribeState }) {
  const open = () => {
    window.location.hash = "#brain/activity";
  };
  const { status, toast } = scribe;
  return (
    <div className="scribe">
      <button
        className={`scribe-btn ${status}`}
        aria-label={LABEL[status]}
        title={
          status === "writing"
            ? "The scribe is writing down what you discovered in this scene…"
            : LABEL[status]
        }
        onClick={open}
      >
        <svg
          width="17"
          height="17"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          className={status === "writing" ? "pulse" : ""}
        >
          <path d="M20 4 8 16l-4 4 1-5L17 3l3 1z" />
        </svg>
      </button>
      {status === "writing" && <span className="scribe-dot writing" />}
      {status === "warn" && !toast && <span className="scribe-dot warn" />}
      {toast && (
        <button className={`scribe-toast ${status}`} onClick={open}>
          {status === "done" && (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#a9c47e" strokeWidth="2.2">
              <path d="m4 12.5 5 5L20 6.5" />
            </svg>
          )}
          <span>{toast}</span>
        </button>
      )}
    </div>
  );
}
