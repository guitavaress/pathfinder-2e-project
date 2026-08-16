/**
 * Cliente das rotas /brain/* + parse dos Markdown off-grid (Journal/Timeline).
 * Tipos espelham o servidor (packages/brain/src/view.ts e write.ts) — mesmo
 * padrão do api.ts com o StreamEvent.
 */

export const NODE_TYPES = ["npc", "place", "faction", "quest", "item", "lore"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Cor/rotulagem por tipo de nó (tema constelação — handoff design_handoff_brain). */
export const TYPE_META: Record<NodeType, { label: string; color: string }> = {
  npc: { label: "NPC", color: "#e3c878" },
  place: { label: "Place", color: "#9ab873" },
  faction: { label: "Faction", color: "#c97c6a" },
  quest: { label: "Quest", color: "#7fb0b5" },
  item: { label: "Item", color: "#c2853f" },
  lore: { label: "Lore", color: "#a98fc9" },
};

export const STATUS_META: Record<string, { color: string; border: string }> = {
  active: { color: "#a9c47e", border: "#4a5a34" },
  resolved: { color: "#9a8868", border: "#3a2e20" },
  dead: { color: "#d98a82", border: "#6e342f" },
  unknown: { color: "#8a7a5e", border: "#322820" },
};

export interface BrainGraphNode {
  stem: string;
  name: string;
  type: NodeType;
  status: string;
  tags: string[];
  created: string;
  updated: string;
  description: string;
  log: { stamp: string; text: string }[];
  connections: { label: string; to: string }[];
}

export interface BrainGraph {
  nodes: BrainGraphNode[];
  edges: { from: string; to: string; label: string }[];
  meta: { session: number; turn: number };
}

export interface BrainActivityPass {
  stamp: string;
  applied: string[];
  rejected: { command: string; reason: string }[];
  error?: string;
}

export interface BrainActivityFeed {
  activity: BrainActivityPass[];
  writing: boolean;
}

export interface JournalSession {
  n: number;
  entries: { stamp: string; text: string }[];
}

export interface TimelineEntry {
  s: string;
  text: string;
}

export interface BrainData {
  graph: BrainGraph;
  journal: JournalSession[];
  timeline: TimelineEntry[];
  activity: BrainActivityPass[];
  writing: boolean;
}

/** "S3.T12" → "Sessão 3 · Turno 12" (util compartilhado do handoff). */
export function humanStamp(s: string): string {
  const m = /^S(\d+)\.T(\d+)$/.exec(s ?? "");
  return m ? `Session ${m[1]} · Turn ${m[2]}` : s;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`GET ${path} → HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Journal.md: cabeçalhos `## Session N` + bullets `- [S1.T3] texto`. */
export function parseJournal(md: string): JournalSession[] {
  const sessions: JournalSession[] = [];
  let current: JournalSession | null = null;
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    const header = /^##\s+Session\s+(\d+)/i.exec(line);
    if (header) {
      current = { n: Number(header[1]), entries: [] };
      sessions.push(current);
      continue;
    }
    const entry = /^-\s+(?:\[(S\d+\.T\d+)\]\s*)?(.+)$/.exec(line);
    if (entry?.[2] && current) {
      current.entries.push({ stamp: entry[1] ?? "", text: entry[2].trim() });
    }
  }
  // Mais recente primeiro, como no protótipo (1D).
  return sessions.reverse();
}

/** Timeline.md: bullets `- [S1] texto` (ordem cronológica preservada). */
export function parseTimeline(md: string): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  for (const raw of md.split("\n")) {
    const m = /^-\s+(?:\[(S\d+)\]\s*)?(.+)$/.exec(raw.trim());
    if (m?.[2]) out.push({ s: m[1] ?? "", text: m[2].trim() });
  }
  return out;
}

export async function fetchBrainData(): Promise<BrainData> {
  const [graph, offGrid, feed] = await Promise.all([
    getJson<BrainGraph>("/brain/graph"),
    getJson<{ journal: string; timeline: string }>("/brain/journal"),
    getJson<BrainActivityFeed>("/brain/activity"),
  ]);
  return {
    graph,
    journal: parseJournal(offGrid.journal),
    timeline: parseTimeline(offGrid.timeline),
    activity: [...feed.activity].reverse(),
    writing: feed.writing,
  };
}

export async function fetchActivity(): Promise<BrainActivityFeed> {
  return getJson<BrainActivityFeed>("/brain/activity");
}
