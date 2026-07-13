/**
 * Tab Timeline (frame 1D): cronologia do mundo em coluna de leitura 640px,
 * linha vertical com marcadores dourados (glow), carimbo por sessão.
 */
import type { TimelineEntry } from "./api.js";

export function TimelineView({ entries }: { entries: TimelineEntry[] }) {
  if (entries.length === 0) {
    return (
      <div className="brain-center">
        <p className="brain-soft-italic">
          A cronologia ainda não tem marcos. Eventos dignos da história do mundo
          aparecerão aqui conforme o escriba os registrar.
        </p>
      </div>
    );
  }

  return (
    <div className="brain-reader">
      <div className="brain-reader-col">
        <div className="brain-ornament">
          <span className="brain-ornament-rule left" />
          <span className="brain-ornament-label">Cronologia do Mundo</span>
          <span className="brain-ornament-rule right" />
        </div>
        <div className="brain-timeline">
          <div className="brain-timeline-line" />
          {entries.map((t, i) => (
            <div key={i} className="brain-timeline-entry">
              <span className="brain-timeline-dot" />
              {t.s && <span className="brain-timeline-stamp">{t.s}</span>}
              <p>{t.text}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
