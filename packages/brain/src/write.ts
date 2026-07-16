/**
 * Write pass: depois que a resposta do turno já foi streamada, o MESMO modelo
 * residente extrai o que vale lembrar e emite comandos CRUD delimitados
 * (parse + gates em commands.ts). O cliente de modelo é INJETADO (`complete`)
 * — este pacote não conhece OpenAI nem o servidor local, e é testável sem GPU.
 *
 * Fronteira do conhecimento revelado É estrutural: o bundle só carrega texto
 * que o JOGADOR viu (mensagem, resumo player-safe, narração). LORE.md nunca
 * entra aqui, então segredo de GM não tem como vazar para o brain.
 */
import { applyCommands, parseCommands, type ApplyReport } from "./commands.js";
import { relevantStems } from "./routing.js";
import { NODE_TYPES } from "./schema.js";
import type { BrainStore } from "./store.js";

export interface TurnBundle {
  playerText: string;
  mechanical: string;
  narration: string;
}

export interface BrainActivity {
  stamp: string;
  applied: string[];
  rejected: { command: string; reason: string }[];
  /** Erro de infra (modelo fora do ar etc.) — pass inteiro não aplicou. */
  error?: string;
}

/** Instruções clean-room do write pass (nenhum texto do Lemma). */
function instructions(): string {
  return [
    "You maintain the PROTAGONIST'S MEMORY of a tabletop RPG world as short Markdown files.",
    "From this turn's events, extract ONLY durable world facts the protagonist learned: people met, places visited, factions, quests taken/resolved, significant items, lore.",
    "Output ONLY commands in this exact format (no prose before, between, or after):",
    "=== CREATE Name.md ===",
    "---",
    `type: one of ${NODE_TYPES.join(" | ")}`,
    "status: optional (active/resolved/dead/unknown)",
    "tags: [optional, lowercase]",
    "---",
    "# Name",
    "One short paragraph describing it as the protagonist currently understands it.",
    "",
    "## Log",
    "- One bullet per new fact learned this turn.",
    "",
    "## Connections",
    "- relation [[Other Node]]",
    "=== UPDATE Name.md ===",
    "(same file format — full replacement; keep old facts, append new Log bullets)",
    "=== TIMELINE ===",
    "- One bullet for a story-level event worth the world's chronology.",
    "",
    "Rules: at most 3 commands; only entities NAMED in this turn's text; UPDATE existing entities instead of creating near-duplicates; never invent facts the turn did not show; if nothing is worth remembering output exactly NOTHING_TO_SAVE.",
  ].join("\n");
}

/** Monta o prompt do write pass para um lote de turnos (coalescidos). */
export function buildWritePrompt(
  store: BrainStore,
  bundles: TurnBundle[],
): string {
  const map = store.readMap();
  const mapBlock = Object.entries(map)
    .slice(0, 40)
    .map(([s, d]) => `- ${s}: ${d}`)
    .join("\n");
  const turnText = bundles
    .map((b) => `${b.playerText}\n${b.mechanical}\n${b.narration}`)
    .join("\n");
  const context = relevantStems(map, turnText, 3)
    .map((stem) => {
      const node = store.readNode(stem);
      return node ? `=== CURRENT ${stem}.md ===\n${node.body.slice(0, 600)}` : "";
    })
    .filter(Boolean)
    .join("\n");
  const turns = bundles
    .map(
      (b, i) =>
        `--- TURN ${i + 1} ---\nPLAYER: ${b.playerText}\nRESULTS: ${b.mechanical || "(no mechanics)"}\nNARRATION: ${b.narration}`,
    )
    .join("\n");
  return [
    instructions(),
    mapBlock ? `EXISTING MEMORY FILES:\n${mapBlock}` : "EXISTING MEMORY FILES: (none yet)",
    context,
    turns,
    "COMMANDS:",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/** Roda um write pass completo: prompt → modelo → parse → gates → aplicação. */
export async function runWritePass(opts: {
  store: BrainStore;
  bundles: TurnBundle[];
  stamp: string;
  complete: (prompt: string) => Promise<string>;
}): Promise<BrainActivity> {
  const { store, bundles, stamp, complete } = opts;
  try {
    const output = await complete(buildWritePrompt(store, bundles));
    if (/^\s*NOTHING_TO_SAVE\s*$/m.test(output) && !output.includes("===")) {
      return { stamp, applied: [], rejected: [] };
    }
    const turnText = bundles
      .map((b) => `${b.playerText}\n${b.mechanical}\n${b.narration}`)
      .join("\n");
    const report: ApplyReport = applyCommands(
      store,
      parseCommands(output),
      turnText,
      stamp,
    );
    return { stamp, ...report };
  } catch (err) {
    return {
      stamp,
      applied: [],
      rejected: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Fila single-flight com coalescência: turnos que chegam durante um pass
 * pendente são agrupados no próximo (o modelo local atende uma requisição por
 * vez — geração de fundo não pode atrasar o rules stage do turno seguinte).
 */
export class WritePassQueue {
  private pending: TurnBundle[] = [];
  private running = false;

  constructor(
    private readonly run: (bundles: TurnBundle[]) => Promise<void>,
  ) {}

  push(bundle: TurnBundle): void {
    this.pending.push(bundle);
    void this.drain();
  }

  /** Há pass rodando ou aguardando? (alimenta o indicador "escriba anotando"). */
  get busy(): boolean {
    return this.running || this.pending.length > 0;
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const batch = this.pending.splice(0, this.pending.length);
        await this.run(batch);
      }
    } finally {
      this.running = false;
    }
  }
}
