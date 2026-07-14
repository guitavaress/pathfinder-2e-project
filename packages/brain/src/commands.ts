/**
 * Protocolo de escrita do write pass: o modelo emite comandos delimitados em
 * texto puro (um 12B local segue isso com mais confiança do que tool-calling):
 *
 *   === CREATE Vexcia.md ===
 *   <arquivo completo do nó>
 *   === UPDATE Coppergate.md ===
 *   <arquivo completo substituto>
 *   === TIMELINE ===
 *   - Subornou a administradora do portão
 *   === JOURNAL ===
 *   - Conheceu Kaelen no East Gate
 *
 * A ENGINE não confia no modelo (doutrina): todo comando passa por gates —
 * path/nome, frontmatter zod, mention gate (só cria nó nomeado no texto do
 * turno), dedup gate (nome fuzzy-existente vira sugestão de UPDATE), cap de
 * comandos e de tamanho. Journal/Timeline são só-append. Rejeições são
 * logadas, nunca lançam — um pass ilegível aplica nada e não corrompe.
 */
import {
  FrontmatterSchema,
  NODE_TYPES,
  normalizeName,
  serializeNode,
  STEM_RE,
} from "./schema.js";
import type { BrainStore } from "./store.js";

export interface BrainCommand {
  kind: "create" | "update" | "timeline" | "journal";
  /** Stem do nó (sem .md) — só para create/update. */
  stem?: string;
  body: string;
}

export interface ApplyReport {
  applied: string[];
  rejected: { command: string; reason: string }[];
}

const MAX_COMMANDS = 4;
const MAX_BODY = 2500;

const HEADER_RE = /^===\s*(CREATE|UPDATE|TIMELINE|JOURNAL)(?:\s+([^=\n]+?\.md))?\s*===\s*$/gim;

/** Extrai os comandos do texto cru do modelo (tolerante a lixo em volta). */
export function parseCommands(text: string): BrainCommand[] {
  const out: BrainCommand[] = [];
  const headers: { kind: string; stem?: string; end: number }[] = [];
  let m: RegExpExecArray | null;
  HEADER_RE.lastIndex = 0;
  while ((m = HEADER_RE.exec(text))) {
    headers.push({
      kind: m[1]!.toLowerCase(),
      stem: m[2]?.trim().replace(/\.md$/i, ""),
      end: m.index + m[0].length,
    });
  }
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i]!;
    const bodyEnd = i + 1 < headers.length ? text.indexOf("===", h.end) : text.length;
    const body = text.slice(h.end, bodyEnd === -1 ? text.length : bodyEnd).trim();
    out.push({
      kind: h.kind as BrainCommand["kind"],
      stem: h.stem,
      body: body.slice(0, MAX_BODY),
    });
  }
  return out;
}

/** Frontmatter tolerante vindo do modelo (para extrair type/status/tags). */
function extractModelFront(body: string): {
  type?: string;
  status?: string;
  tags: string[];
  rest: string;
} {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(body.trim());
  if (!m) return { tags: [], rest: body.trim() };
  const fields: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) fields[kv[1]!] = kv[2]!.trim();
  }
  const tags = (fields.tags ?? "")
    .replace(/^\[|\]$/g, "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return { type: fields.type, status: fields.status, tags, rest: m[2]!.trim() };
}

/**
 * Aplica os comandos com todos os gates. `turnText` é TUDO que o jogador viu
 * neste turno (mensagem + resumo mecânico + narração) — a fronteira do
 * conhecimento revelado E a fonte do mention gate.
 */
export function applyCommands(
  store: BrainStore,
  commands: BrainCommand[],
  turnText: string,
  stamp: string,
): ApplyReport {
  const report: ApplyReport = { applied: [], rejected: [] };
  const turnNorm = normalizeName(turnText);

  for (const cmd of commands.slice(0, MAX_COMMANDS)) {
    const label = `${cmd.kind.toUpperCase()}${cmd.stem ? ` ${cmd.stem}.md` : ""}`;

    if (cmd.kind === "timeline" || cmd.kind === "journal") {
      const lines = cmd.body
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("- "))
        .slice(0, 5);
      if (lines.length === 0) {
        report.rejected.push({ command: label, reason: "no '- ' entry lines" });
        continue;
      }
      if (cmd.kind === "timeline") store.appendTimeline(lines, stamp);
      else store.appendJournal(lines, stamp);
      report.applied.push(label);
      continue;
    }

    // CREATE / UPDATE ------------------------------------------------------
    const stem = cmd.stem ?? "";
    if (!STEM_RE.test(stem) || store.isOffGrid(stem)) {
      report.rejected.push({ command: label, reason: "invalid or off-grid node name" });
      continue;
    }
    const existing = store.readNode(stem);
    const fuzzy = store.findStem(stem);

    if (cmd.kind === "create") {
      // Dedup gate: nome fuzzy-existente não vira nó duplicado.
      if (existing || (fuzzy && fuzzy !== stem)) {
        report.rejected.push({
          command: label,
          reason: `node "${fuzzy ?? stem}" already exists — use UPDATE ${fuzzy ?? stem}.md`,
        });
        continue;
      }
      // Mention gate: só nasce nó que a cena deste turno NOMEOU.
      if (!turnNorm.includes(normalizeName(stem))) {
        report.rejected.push({
          command: label,
          reason: "name does not appear in this turn's text (mention gate)",
        });
        continue;
      }
    }
    if (cmd.kind === "update" && !existing) {
      report.rejected.push({
        command: label,
        reason: fuzzy ? `no such node — did you mean UPDATE ${fuzzy}.md?` : "no such node",
      });
      continue;
    }

    // Normalização: a ENGINE controla os carimbos e valida o type — o modelo
    // não escreve frontmatter por conta própria no disco.
    const model = extractModelFront(cmd.body);
    const type = (model.type ?? existing?.front.type ?? "").toLowerCase();
    if (!(NODE_TYPES as readonly string[]).includes(type)) {
      report.rejected.push({
        command: label,
        reason: `missing/unknown type "${model.type ?? ""}" (valid: ${NODE_TYPES.join(", ")})`,
      });
      continue;
    }
    const front = FrontmatterSchema.parse({
      created: existing?.front.created ?? stamp,
      updated: stamp,
      type,
      ...(model.status ?? existing?.front.status
        ? { status: model.status ?? existing?.front.status }
        : {}),
      tags: model.tags.length ? model.tags : (existing?.front.tags ?? []),
    });
    const body = model.rest.startsWith("#") ? model.rest : `# ${stem}\n${model.rest}`;
    const write = store.writeNode(stem, serializeNode(front, body));
    if (!write.ok) {
      report.rejected.push({ command: label, reason: write.error });
      continue;
    }
    report.applied.push(label);
  }

  for (const extra of commands.slice(MAX_COMMANDS)) {
    report.rejected.push({
      command: extra.kind.toUpperCase(),
      reason: `over the ${MAX_COMMANDS}-command cap`,
    });
  }
  return report;
}
