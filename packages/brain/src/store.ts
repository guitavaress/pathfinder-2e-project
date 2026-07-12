/**
 * Storage do Brain: um diretório de arquivos Markdown (fonte de verdade) +
 * índice derivado (map.json) e metadados de tempo (meta.json). Sem banco,
 * sem embeddings — o grafo é derivado dos arquivos, e o usuário pode editar
 * qualquer .md na mão (escape hatch humano).
 *
 * Off-grid (não são nós do grafo): Protagonist.md (raiz), Journal.md
 * (diário de sessão, append-only), Timeline.md (cronologia in-world,
 * append-only), map.json, meta.json.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  parseNode,
  serializeNode,
  STEM_RE,
  normalizeName,
  type BrainNode,
} from "./schema.js";

const OFF_GRID = new Set(["protagonist", "journal", "timeline"]);

export interface BrainMeta {
  session: number;
  turn: number;
}

export class BrainStore {
  constructor(readonly dir: string) {}

  // ------------------------------------------------------------------ init
  /** Cria o diretório e os arquivos-base se não existirem (idempotente). */
  ensureInit(protagonist?: { name: string; summary: string }): void {
    mkdirSync(this.dir, { recursive: true });
    const journal = join(this.dir, "Journal.md");
    if (!existsSync(journal)) writeFileSync(journal, "# Journal\n");
    const timeline = join(this.dir, "Timeline.md");
    if (!existsSync(timeline)) writeFileSync(timeline, "# Timeline\n");
    const meta = join(this.dir, "meta.json");
    if (!existsSync(meta)) {
      writeFileSync(meta, JSON.stringify({ session: 0, turn: 0 }));
    }
    const prot = join(this.dir, "Protagonist.md");
    if (!existsSync(prot) && protagonist) {
      writeFileSync(
        prot,
        `# ${protagonist.name}\n${protagonist.summary}\n\n## Log\n\n## Connections\n`,
      );
    }
    if (!existsSync(join(this.dir, "map.json"))) this.rebuildMap();
  }

  // ------------------------------------------------------------------ meta
  meta(): BrainMeta {
    try {
      return JSON.parse(readFileSync(join(this.dir, "meta.json"), "utf8")) as BrainMeta;
    } catch {
      return { session: 0, turn: 0 };
    }
  }

  private writeMeta(m: BrainMeta): void {
    writeFileSync(join(this.dir, "meta.json"), JSON.stringify(m));
  }

  /** Nova sessão de jogo: S+1, turno zerado. */
  bumpSession(): BrainMeta {
    const m = this.meta();
    const next = { session: m.session + 1, turn: 0 };
    this.writeMeta(next);
    return next;
  }

  /** Novo turno: T+1. Devolve o carimbo corrente ("S3.T12"). */
  bumpTurn(): string {
    const m = this.meta();
    const next = { session: Math.max(1, m.session), turn: m.turn + 1 };
    this.writeMeta(next);
    return `S${next.session}.T${next.turn}`;
  }

  stamp(): string {
    const m = this.meta();
    return `S${Math.max(1, m.session)}.T${m.turn}`;
  }

  // ----------------------------------------------------------------- nodes
  isOffGrid(stem: string): boolean {
    return OFF_GRID.has(normalizeName(stem));
  }

  /** Path seguro de um nó; null quando o stem é inválido ou escapa do dir. */
  nodePath(stem: string): string | null {
    if (!STEM_RE.test(stem) || this.isOffGrid(stem)) return null;
    const p = resolve(this.dir, `${stem}.md`);
    if (!p.startsWith(resolve(this.dir) + "/")) return null;
    return p;
  }

  /** Stems dos nós do grafo (exclui off-grid). */
  listStems(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.slice(0, -3))
      .filter((s) => !this.isOffGrid(s))
      .sort();
  }

  readNode(stem: string): BrainNode | null {
    const p = this.nodePath(stem);
    if (!p || !existsSync(p)) return null;
    const parsed = parseNode(stem, readFileSync(p, "utf8"));
    return parsed.node ?? null;
  }

  /** Acha um stem existente por nome fuzzy (dedup gate). */
  findStem(name: string): string | null {
    const q = normalizeName(name);
    if (!q) return null;
    for (const stem of this.listStems()) {
      const n = normalizeName(stem);
      if (n === q || n.includes(q) || q.includes(n)) return stem;
    }
    return null;
  }

  /**
   * Escreve um nó VALIDADO (frontmatter zod + guards de path) e reconstrói o
   * map. Devolve erro legível em vez de lançar — o write pass loga e segue.
   */
  writeNode(stem: string, raw: string): { ok: true } | { ok: false; error: string } {
    const p = this.nodePath(stem);
    if (!p) return { ok: false, error: `invalid or off-grid node name "${stem}"` };
    const parsed = parseNode(stem, raw);
    if (!parsed.node) return { ok: false, error: parsed.error ?? "unparseable node" };
    writeFileSync(p, raw.trimEnd() + "\n");
    this.rebuildMap();
    return { ok: true };
  }

  // ------------------------------------------------------------------- map
  /** map.json: {stem: descrição de 1 linha} — o índice que cabe em contexto. */
  rebuildMap(): void {
    const map: Record<string, string> = {};
    for (const stem of this.listStems()) {
      const node = this.readNode(stem);
      if (node) map[stem] = `${node.front.type}: ${node.description}`.slice(0, 100);
    }
    writeFileSync(join(this.dir, "map.json"), JSON.stringify(map, null, 1));
  }

  readMap(): Record<string, string> {
    try {
      return JSON.parse(readFileSync(join(this.dir, "map.json"), "utf8")) as Record<
        string,
        string
      >;
    } catch {
      return {};
    }
  }

  // --------------------------------------------------- journal & timeline
  /**
   * Journal é APPEND-ONLY: nunca reescreve histórico. Abre um cabeçalho
   * `## Session N` quando a sessão corrente ainda não tem um.
   */
  appendJournal(lines: string[], stamp: string): void {
    if (lines.length === 0) return;
    const p = join(this.dir, "Journal.md");
    const current = existsSync(p) ? readFileSync(p, "utf8") : "# Journal\n";
    const session = stamp.split(".")[0]!.slice(1);
    const header = `## Session ${session}`;
    const withHeader = current.includes(`${header}\n`) ? current : `${current}\n${header}\n`;
    const entries = lines
      .map((l) => (l.startsWith("- ") ? l : `- ${l}`))
      .map((l) => (l.includes(`[${stamp}]`) ? l : l.replace(/^- /, `- [${stamp}] `)))
      .join("\n");
    writeFileSync(p, `${withHeader}${entries}\n`);
  }

  /** Timeline: cronologia in-world, append-only, carimbada por sessão. */
  appendTimeline(lines: string[], stamp: string): void {
    if (lines.length === 0) return;
    const p = join(this.dir, "Timeline.md");
    const current = existsSync(p) ? readFileSync(p, "utf8") : "# Timeline\n";
    const session = stamp.split(".")[0];
    const entries = lines
      .map((l) => (l.startsWith("- ") ? l : `- ${l}`))
      .map((l) => (/^- \[S\d+\]/.test(l) ? l : l.replace(/^- /, `- [${session}] `)))
      .join("\n");
    writeFileSync(p, `${current}${entries}\n`);
  }

  /** Últimas N linhas de entrada do Journal (para injeção de contexto). */
  journalTail(n: number): string[] {
    const p = join(this.dir, "Journal.md");
    if (!existsSync(p)) return [];
    return readFileSync(p, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("- "))
      .slice(-n);
  }

  readOffGrid(name: "Journal" | "Timeline" | "Protagonist"): string {
    const p = join(this.dir, `${name}.md`);
    return existsSync(p) ? readFileSync(p, "utf8") : "";
  }
}
