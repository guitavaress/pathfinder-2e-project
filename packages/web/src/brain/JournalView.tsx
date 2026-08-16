/**
 * Tab Journal (frame 1D): nav lateral de sessões (200px) + coluna de leitura
 * 640px. Âncoras rolam o container (scrollTop — nunca scrollIntoView, quebra
 * o app). Linhas de Check/Combat em verde-ok.
 */
import { useRef } from "react";
import type { JournalSession } from "./api.js";

const MECHANICAL_RE = /check|combat|victory|defeat|stabilizes|dies|rest|treat wounds/i;

export function JournalView({ sessions }: { sessions: JournalSession[] }) {
  const readerRef = useRef<HTMLDivElement>(null);

  if (sessions.length === 0 || sessions.every((s) => s.entries.length === 0)) {
    return (
      <div className="brain-center">
        <p className="brain-soft-italic">
          O diário ainda está em branco. O Mestre o escreve a cada evento
          mecânico — combates, descobertas, descansos.
        </p>
      </div>
    );
  }

  const goTo = (n: number) => {
    const reader = readerRef.current;
    const el = reader?.querySelector<HTMLElement>(`[data-session="${n}"]`);
    if (reader && el) reader.scrollTop = el.offsetTop - 20;
  };

  return (
    <div className="brain-journal">
      <nav className="brain-session-nav">
        <span className="brain-session-nav-h">Sessions</span>
        {sessions.map((s) => (
          <button key={s.n} className="brain-session-link" onClick={() => goTo(s.n)}>
            <span className="brain-session-num">S{s.n}</span>
            <span>Session {s.n}</span>
          </button>
        ))}
        <div className="brain-topbar-spring" />
        <p className="brain-session-nav-hint">
          O Journal é escrito pelo Mestre a cada turno; a Timeline resume o mundo.
        </p>
      </nav>
      <div className="brain-reader" ref={readerRef}>
        <div className="brain-reader-col">
          {sessions.map((s) => (
            <div key={s.n} data-session={s.n}>
              <div className="brain-ornament">
                <span className="brain-ornament-rule left" />
                <span className="brain-ornament-label">Session {s.n}</span>
                <span className="brain-ornament-rule right" />
              </div>
              <div className="brain-journal-entries">
                {s.entries.map((e, i) => (
                  <div key={i} className="brain-journal-entry">
                    <span className="brain-journal-stamp">{e.stamp}</span>
                    <p className={MECHANICAL_RE.test(e.text) ? "mech" : ""}>{e.text}</p>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
