/**
 * Read pass da v1 — SEM chamada de modelo (latência zero por turno): match de
 * palavras-chave entre o texto do turno e os nomes do map.json. Um routing
 * pass por modelo (como no Lemma) pode entrar depois atrás de flag, quando a
 * latência for medida.
 */
import { normalizeName } from "./schema.js";
import type { BrainStore } from "./store.js";

/** Stems relevantes para um texto (nome contido no texto; maiores primeiro). */
export function relevantStems(
  map: Record<string, string>,
  text: string,
  k = 3,
): string[] {
  const t = normalizeName(text);
  if (!t) return [];
  return Object.keys(map)
    .filter((stem) => t.includes(normalizeName(stem)))
    .sort((a, b) => b.length - a.length)
    .slice(0, k);
}

const BLOCK_CAP = 1500;
const NODE_CAP = 450;
const JOURNAL_TAIL = 12;

/**
 * Bloco "o que o protagonista sabe" para o prompt do narrador: one-liners do
 * map + cauda do Journal + corpo dos nós citados no texto do turno. Capado —
 * contexto de 12B é orçamento, não lago.
 */
export function knowledgeBlock(store: BrainStore, turnText: string): string {
  const map = store.readMap();
  const parts: string[] = [];

  const entries = Object.entries(map).slice(0, 30);
  if (entries.length) {
    parts.push(
      "Known entities: " + entries.map(([s, d]) => `${s} (${d})`).join("; "),
    );
  }
  const tail = store.journalTail(JOURNAL_TAIL);
  if (tail.length) parts.push(`Recent journal:\n${tail.join("\n")}`);

  for (const stem of relevantStems(map, turnText)) {
    const node = store.readNode(stem);
    if (node) parts.push(`--- ${stem} ---\n${node.body.slice(0, NODE_CAP)}`);
  }

  if (parts.length === 0) return "";
  const block = parts.join("\n\n");
  return (
    "# What your protagonist knows (accumulated across sessions — consistent past, do not contradict it)\n" +
    (block.length > BLOCK_CAP ? `${block.slice(0, BLOCK_CAP)}…` : block)
  );
}
