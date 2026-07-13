/**
 * Grimório da Memória (frame 1G — overlay full-screen, direção recomendada):
 * abre por botão no trilho ou tecla B, fecha com Esc, rota hash #brain
 * (sub-rota por tab). Foco preso no overlay enquanto aberto.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchBrainData, type BrainData } from "./api.js";
import { ActivityView } from "./ActivityView.js";
import { GraphView } from "./GraphView.js";
import { JournalView } from "./JournalView.js";
import { TimelineView } from "./TimelineView.js";

export type BrainTab = "graph" | "journal" | "timeline" | "activity";

const TABS: { id: BrainTab; label: string }[] = [
  { id: "graph", label: "Grafo" },
  { id: "journal", label: "Journal" },
  { id: "timeline", label: "Timeline" },
  { id: "activity", label: "Atividade" },
];

interface Props {
  tab: BrainTab;
  onTab: (tab: BrainTab) => void;
  onClose: () => void;
}

export function BrainOverlay({ tab, onTab, onClose }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<BrainData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await fetchBrainData());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Foco preso + Esc fecha.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const previous = document.activeElement as HTMLElement | null;
    root.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'button, input, [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    root.addEventListener("keydown", onKey);
    return () => {
      root.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [onClose]);

  const meta = data?.graph.meta;

  return (
    <div
      className="brain-overlay"
      ref={rootRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label="Grimório da Memória"
    >
      <header className="brain-topbar">
        <div className="brain-brand">
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="#c6a24c" strokeWidth="1.5">
            <circle cx="12" cy="5" r="2.2" />
            <circle cx="5" cy="14" r="2.2" />
            <circle cx="19" cy="14" r="2.2" />
            <circle cx="12" cy="20" r="1.6" />
            <path d="M12 7.2 6 12.2M12 7.2l6 5M6.8 15.6l3.8 3.4M17.2 15.6l-3.8 3.4" />
          </svg>
          <span>Grimório da Memória</span>
        </div>
        <nav className="brain-tabs">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`brain-tab${tab === t.id ? " active" : ""}`}
              onClick={() => onTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        <div className="brain-topbar-spring" />
        {meta && meta.session > 0 && (
          <span className="brain-stamp-badge">
            S{meta.session} · T{meta.turn}
          </span>
        )}
        <button className="brain-close" aria-label="Fechar (Esc)" onClick={onClose}>
          ✕
        </button>
      </header>

      {loading && (
        <div className="brain-center">
          <div className="typing" style={{ justifyContent: "center" }}>
            <span className="dots">
              <i />
              <i />
              <i />
            </span>
          </div>
          <p className="brain-soft-italic">Abrindo o grimório…</p>
          <p className="brain-ghost">GET /brain/map</p>
        </div>
      )}

      {!loading && error && (
        <div className="brain-center">
          <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#c97c6a" strokeWidth="1.6">
            <path d="M12 3 2.5 20h19L12 3z" />
            <path d="M12 10v4M12 17h.01" />
          </svg>
          <p className="brain-error-title">A memória não respondeu</p>
          <p className="brain-soft-italic">
            Não foi possível ler /brain. O servidor local está de pé?
          </p>
          <p className="brain-ghost">{error}</p>
          <button className="brain-retry" onClick={() => void load()}>
            Tentar de novo
          </button>
        </div>
      )}

      {!loading && !error && data && (
        <div className="brain-body">
          {tab === "graph" && <GraphView graph={data.graph} onBackToScene={onClose} />}
          {tab === "journal" && <JournalView sessions={data.journal} />}
          {tab === "timeline" && <TimelineView entries={data.timeline} />}
          {tab === "activity" && <ActivityView activity={data.activity} />}
        </div>
      )}
    </div>
  );
}
