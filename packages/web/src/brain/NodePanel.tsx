/**
 * Drawer do nó (frame 1A, 392px): badges de tipo/status, meta humanizada do
 * carimbo, tags, descrição, Log (timeline com pontos dourados) e Connections
 * clicáveis (selecionam e centralizam o alvo no grafo).
 */
import {
  humanStamp,
  STATUS_META,
  TYPE_META,
  type BrainGraph,
  type BrainGraphNode,
} from "./api.js";

interface Props {
  node: BrainGraphNode;
  graph: BrainGraph;
  onClose: () => void;
  onGo: (stem: string) => void;
}

function resolveStem(graph: BrainGraph, to: string): string | null {
  const q = to.trim().toLowerCase();
  const hit = graph.nodes.find((n) => n.stem.toLowerCase() === q);
  return hit?.stem ?? null;
}

export function NodePanel({ node, graph, onClose, onGo }: Props) {
  const type = TYPE_META[node.type];
  const status = node.status
    ? STATUS_META[node.status] ?? { color: "#9a8868", border: "#3a2e20" }
    : null;

  return (
    <>
      <div className="brain-node-head">
        <div className="brain-node-badges">
          <span
            className="brain-badge"
            style={{
              color: type.color,
              borderColor: `${type.color}73`,
              background: `${type.color}14`,
            }}
          >
            {type.label}
          </span>
          {status && (
            <span
              className="brain-badge"
              style={{ color: status.color, borderColor: status.border }}
            >
              {node.status}
            </span>
          )}
          <div className="brain-topbar-spring" />
          <button className="brain-close sm" aria-label="Fechar painel" onClick={onClose}>
            ✕
          </button>
        </div>
        <h2 className="brain-node-name">{node.name}</h2>
        <p className="brain-node-meta">
          Descoberto na {humanStamp(node.created)} · atualizado na {humanStamp(node.updated)}
        </p>
        {node.tags.length > 0 && (
          <div className="brain-node-tags">
            {node.tags.map((tag) => (
              <span key={tag} className="brain-tag">
                #{tag}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="brain-node-scroll">
        <p className="brain-node-desc">{node.description}</p>

        {node.log.length > 0 && (
          <>
            <div className="brain-section-h">
              <span>Log</span>
              <span className="brain-section-rule" />
            </div>
            <div className="brain-log">
              <div className="brain-log-line" />
              {node.log.map((entry, i) => (
                <div key={i} className="brain-log-entry">
                  <span className="brain-log-dot" />
                  {entry.stamp && <span className="brain-log-stamp">{entry.stamp}</span>}
                  <p>{entry.text}</p>
                </div>
              ))}
            </div>
          </>
        )}

        {node.connections.length > 0 && (
          <>
            <div className="brain-section-h">
              <span>Connections</span>
              <span className="brain-section-rule" />
            </div>
            <div className="brain-conns">
              {node.connections.map((conn, i) => {
                const target = resolveStem(graph, conn.to);
                const dot = target
                  ? TYPE_META[graph.nodes.find((n) => n.stem === target)!.type].color
                  : "#3e3322";
                return (
                  <button
                    key={i}
                    className="brain-conn"
                    disabled={!target}
                    onClick={() => target && onGo(target)}
                  >
                    <span className="brain-conn-label">{conn.label}</span>
                    <span className="brain-conn-arrow">→</span>
                    <span className="brain-conn-to">{conn.to}</span>
                    <span className="brain-chip-dot" style={{ background: dot }} />
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>
    </>
  );
}
