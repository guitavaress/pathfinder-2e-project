/**
 * Schema dos nós do Brain: o conhecimento que o PROTAGONISTA já revelou do
 * mundo, um arquivo Markdown por entidade. Reimplementação clean-room em
 * TypeScript da arquitetura observada no Lemma (grafo de .md + wikilinks) —
 * nenhum código ou prompt copiado; formato e tipos são nossos, temáticos de RPG.
 *
 * Formato de um nó:
 * ---
 * created: S1.T3          ← carimbo sessão.turno (sem datas de relógio)
 * updated: S2.T10
 * type: npc | place | faction | quest | item | lore
 * status: active          ← livre (active/resolved/dead/unknown...)
 * tags: [cinzalto, guild]
 * ---
 * # Vexcia
 * Descrição como o protagonista entende HOJE.
 *
 * ## Log
 * - [S1.T3] Pagou pela entrega; ofereceu contratos.
 *
 * ## Connections
 * - works_for [[Scavengers Guild]]
 */
import { z } from "zod";

export const NODE_TYPES = ["npc", "place", "faction", "quest", "item", "lore"] as const;
export type NodeType = (typeof NODE_TYPES)[number];

/** Carimbo de tempo in-game: sessão + turno ("S3.T12"). */
export const STAMP_RE = /^S\d+\.T\d+$/;

export const FrontmatterSchema = z.object({
  created: z.string().regex(STAMP_RE),
  updated: z.string().regex(STAMP_RE),
  type: z.enum(NODE_TYPES),
  status: z.string().optional(),
  tags: z.array(z.string()).default([]),
});
export type NodeFrontmatter = z.infer<typeof FrontmatterSchema>;

export interface BrainNode {
  /** Nome do arquivo sem .md — identidade do nó. */
  stem: string;
  front: NodeFrontmatter;
  /** Título (# heading); normalmente igual ao stem. */
  name: string;
  /** Corpo completo abaixo do frontmatter (inclui heading/log/connections). */
  body: string;
  /** Primeira linha de prosa após o título — vira a descrição no map.json. */
  description: string;
  /** Alvos de [[wikilinks]] no corpo (edges do grafo). */
  links: string[];
}

/** Nome de arquivo aceito para um nó (guard de path + higiene de identidade). */
export const STEM_RE = /^[A-Za-z0-9][A-Za-z0-9 '\-]{0,60}$/;

/** Normaliza um nome para comparação (case/diacríticos/espaços). */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Extrai os alvos de [[wikilinks]] de um corpo Markdown. */
export function wikiLinks(body: string): string[] {
  const out = new Set<string>();
  const re = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const t = m[1]!.trim();
    if (t) out.add(t);
  }
  return [...out];
}

/** Parse tolerante do frontmatter (`key: value`; tags aceita [a, b] ou a, b). */
function parseFrontmatterBlock(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const line of block.split("\n")) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (!m) continue;
    const key = m[1]!;
    let value: unknown = m[2]!.trim();
    if (key === "tags") {
      value = String(value)
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    }
    out[key] = value;
  }
  return out;
}

export interface ParseResult {
  node?: BrainNode;
  error?: string;
}

/** Parseia um arquivo de nó; erro legível quando o formato não fecha. */
export function parseNode(stem: string, raw: string): ParseResult {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw.trim());
  if (!m) return { error: "missing frontmatter block (--- ... ---)" };
  const front = FrontmatterSchema.safeParse(parseFrontmatterBlock(m[1]!));
  if (!front.success) {
    return { error: `invalid frontmatter: ${front.error.issues[0]?.message ?? "?"} (${front.error.issues[0]?.path.join(".")})` };
  }
  const body = m[2]!.trim();
  const nameMatch = /^#\s+(.+)$/m.exec(body);
  const name = nameMatch?.[1]?.trim() ?? stem;
  // Descrição = primeira linha de prosa após o título (fora de seções ##).
  const afterTitle = nameMatch
    ? body.slice(body.indexOf(nameMatch[0]) + nameMatch[0].length)
    : body;
  const description =
    afterTitle
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith("#") && !l.startsWith("-")) ?? "";
  return {
    node: {
      stem,
      front: front.data,
      name,
      body,
      description: description.slice(0, 140),
      links: wikiLinks(body),
    },
  };
}

/** Serializa um nó (usado no seed do Protagonist e na normalização de writes). */
export function serializeNode(
  front: NodeFrontmatter,
  body: string,
): string {
  const lines = [
    "---",
    `created: ${front.created}`,
    `updated: ${front.updated}`,
    `type: ${front.type}`,
    ...(front.status ? [`status: ${front.status}`] : []),
    ...(front.tags.length ? [`tags: [${front.tags.join(", ")}]`] : []),
    "---",
    body.trim(),
    "",
  ];
  return lines.join("\n");
}
