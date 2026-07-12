/**
 * Cola do Brain no servidor: storage em `<repo>/brain/` (gitignorado, como
 * LORE.md/WORLD.md; override via BRAIN_PATH; BRAIN_DISABLED=1 desliga tudo).
 * Toda função aqui é fail-safe: erro do brain NUNCA derruba um turno — loga
 * e segue (memória é acessório do jogo, não dependência).
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Character } from "@pf2e/shared";
import {
  BrainStore,
  durableJournalLines,
  knowledgeBlock,
  runWritePass,
  WritePassQueue,
  type BrainActivity,
  type TurnBundle,
} from "@pf2e/brain";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = join(here, "../../../../brain");

let store: BrainStore | null = null;
let queue: WritePassQueue | null = null;
const activity: BrainActivity[] = [];

export function brainEnabled(): boolean {
  return process.env.BRAIN_DISABLED !== "1";
}

export function brainStore(): BrainStore {
  if (!store) {
    store = new BrainStore(process.env.BRAIN_PATH ?? DEFAULT_DIR);
    store.ensureInit();
  }
  return store;
}

/** Nova sessão de jogo: semeia o Protagonist.md e abre S+1 no relógio. */
export function brainSessionStart(character: Character): void {
  if (!brainEnabled()) return;
  try {
    const s = brainStore();
    s.ensureInit({
      name: character.name,
      summary: `${character.ancestry} ${character.className}, level ${character.level}. The protagonist — everything in this memory is what THEY have learned.`,
    });
    s.bumpSession();
  } catch (err) {
    console.warn("[brain] session start failed:", err instanceof Error ? err.message : err);
  }
}

/** Início de turno: avança o relógio e devolve o carimbo ("S3.T12"). */
export function brainTurnStamp(): string {
  if (!brainEnabled()) return "S0.T0";
  try {
    return brainStore().bumpTurn();
  } catch {
    return "S0.T0";
  }
}

/** Journaling determinístico: ground truth mecânico direto no Journal. */
export function brainJournal(mechanical: string, stamp: string): void {
  if (!brainEnabled() || !mechanical) return;
  try {
    brainStore().appendJournal(durableJournalLines(mechanical.split("\n")), stamp);
  } catch (err) {
    console.warn("[brain] journal failed:", err instanceof Error ? err.message : err);
  }
}

/** Bloco "o que o protagonista sabe" para o prompt do narrador ("" se vazio). */
export function brainKnowledge(turnText: string): string {
  if (!brainEnabled()) return "";
  try {
    return knowledgeBlock(brainStore(), turnText);
  } catch {
    return "";
  }
}

/**
 * Write pass assíncrono pós-`done`: fila single-flight com coalescência (o
 * cliente do modelo é injetado pelo agente). Atividade fica num ring buffer
 * para a rota /brain/activity (trilha de auditoria).
 */
export function queueBrainWrite(
  bundle: TurnBundle,
  complete: (prompt: string) => Promise<string>,
): void {
  if (!brainEnabled()) return;
  if (!queue) {
    queue = new WritePassQueue(async (bundles) => {
      const act = await runWritePass({
        store: brainStore(),
        bundles,
        stamp: brainStore().stamp(),
        complete,
      });
      activity.push(act);
      if (activity.length > 50) activity.shift();
      if (act.error) {
        console.warn("[brain] write pass error:", act.error);
      } else {
        console.log(
          `[brain] write pass: applied [${act.applied.join(", ") || "nothing"}]` +
            (act.rejected.length
              ? ` | rejected: ${act.rejected.map((r) => `${r.command} (${r.reason})`).join("; ")}`
              : ""),
        );
      }
    });
  }
  queue.push(bundle);
}

export function brainActivityLog(): BrainActivity[] {
  return [...activity];
}
