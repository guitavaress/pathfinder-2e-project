/**
 * Tab Grafo (frame 1A — constelação, direção fechada): toolbar com busca e
 * chips de filtro por tipo (com contagem), canvas force-directed
 * (graphEngine.ts) e NodePanel em drawer de 392px. Estado vazio do frame 1C.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { NODE_TYPES, TYPE_META, type BrainGraph, type NodeType } from "./api.js";
import { createGraphEngine, type GraphEngine } from "./graphEngine.js";
import { NodePanel } from "./NodePanel.js";

interface Props {
  graph: BrainGraph;
  onBackToScene: () => void;
}

const ALL_ON = Object.fromEntries(NODE_TYPES.map((t) => [t, true])) as Record<
  NodeType,
  boolean
>;

export function GraphView({ graph, onBackToScene }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<GraphEngine | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Record<NodeType, boolean>>(ALL_ON);
  const [zoomHigh, setZoomHigh] = useState(false);

  const counts = useMemo(() => {
    const c: Partial<Record<NodeType, number>> = {};
    for (const n of graph.nodes) c[n.type] = (c[n.type] ?? 0) + 1;
    return c;
  }, [graph]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || graph.nodes.length === 0) return;
    const engine = createGraphEngine(canvas, graph, {
      onSelect: setSelected,
      onZoom: (z) => setZoomHigh(z >= 1.45),
    });
    engineRef.current = engine;
    return () => {
      engineRef.current = null;
      engine.destroy();
    };
  }, [graph]);

  if (graph.nodes.length === 0) {
    return (
      <div className="brain-empty">
        <span className="brain-empty-star" style={{ left: "9%", top: "17%" }} />
        <span className="brain-empty-star" style={{ left: "84%", top: "25%" }} />
        <span className="brain-empty-star" style={{ left: "24%", top: "75%" }} />
        <span className="brain-empty-star" style={{ left: "74%", top: "81%" }} />
        <svg width="60" height="60" viewBox="0 0 24 24" fill="none" stroke="#5a4520" strokeWidth="1">
          <circle cx="12" cy="12" r="9" strokeDasharray="2.5 3.5" />
          <circle cx="12" cy="12" r="1.6" fill="#c6a24c" stroke="none" />
          <path d="M12 3v2M12 19v2M3 12h2M19 12h2" stroke="#4a3d28" />
        </svg>
        <h3>O mundo ainda é um mistério</h3>
        <p>
          Cada pessoa, lugar e segredo que seu personagem descobrir se tornará uma
          estrela neste mapa. Volte à cena — e comece a revelar.
        </p>
        <button className="btn-act" onClick={onBackToScene}>
          ← Voltar à cena
        </button>
      </div>
    );
  }

  const node = selected
    ? graph.nodes.find((n) => n.stem === selected) ?? null
    : null;

  return (
    <div className="brain-graph">
      <div className="brain-toolbar">
        <div className="brain-search">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#7a6c52" strokeWidth="2">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              engineRef.current?.setSearch(e.target.value);
            }}
            placeholder="Buscar por nome…"
            aria-label="Buscar nó por nome"
          />
        </div>
        <div className="brain-chips">
          {NODE_TYPES.map((t) => {
            const on = filters[t];
            const meta = TYPE_META[t];
            return (
              <button
                key={t}
                className={`brain-chip${on ? " on" : ""}`}
                style={
                  on
                    ? {
                        borderColor: `${meta.color}66`,
                        background: `${meta.color}17`,
                      }
                    : undefined
                }
                onClick={() => {
                  engineRef.current?.toggleFilter(t);
                  setFilters((f) => ({ ...f, [t]: !f[t] }));
                }}
                aria-pressed={on}
              >
                <span
                  className="brain-chip-dot"
                  style={{ background: on ? meta.color : "#3e3322" }}
                />
                {meta.label}
                <span
                  className="brain-chip-count"
                  style={{ color: on ? meta.color : "#4a3d28" }}
                >
                  {counts[t] ?? 0}
                </span>
              </button>
            );
          })}
        </div>
        <div className="brain-topbar-spring" />
        <span className="brain-toolbar-stats">
          {graph.nodes.length} nós · {graph.edges.length} ligações · scroll: zoom ·
          arrastar: mover
        </span>
      </div>

      <div className="brain-canvas-wrap">
        <canvas ref={canvasRef} className="brain-canvas" />
        <div className="brain-zoom-hint">
          {zoomHigh
            ? "zoom alto — rótulos das ligações visíveis"
            : "aproxime (scroll) para revelar os rótulos das ligações"}
        </div>
        <div
          className="brain-drawer"
          style={{ transform: node ? "translateX(0)" : "translateX(102%)" }}
          aria-hidden={!node}
        >
          {node && (
            <NodePanel
              node={node}
              graph={graph}
              onClose={() => {
                engineRef.current?.setSelected(null, false);
                setSelected(null);
              }}
              onGo={(stem) => {
                engineRef.current?.setSelected(stem, true);
                setSelected(stem);
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
