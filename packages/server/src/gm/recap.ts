/**
 * Recap determinístico do "Continue campaign": a ENGINE monta os dados
 * (Timeline, quests ativas, última cena do save) e o modelo apenas os narra —
 * o que não está nas linhas não aconteceu, inclusive no "Anteriormente…".
 */
import { parseLog, type BrainStore } from "@pf2e/brain";
import type { SaveGame } from "./save.js";

const TIMELINE_TAIL = 6;
const LAST_SCENE_CAP = 900;

/** Bloco RECAP DATA (texto puro) para o kickoff de retomada. "" se não há nada. */
export function buildRecapData(store: BrainStore, save: SaveGame | null): string {
  const parts: string[] = [];

  const timeline = store
    .readOffGrid("Timeline")
    .split("\n")
    .filter((l) => l.startsWith("- "))
    .slice(-TIMELINE_TAIL);
  if (timeline.length) parts.push(`Recent events:\n${timeline.join("\n")}`);

  const quests: string[] = [];
  for (const stem of store.listStems()) {
    const node = store.readNode(stem);
    if (!node || node.front.type !== "quest") continue;
    if ((node.front.status ?? "active").toLowerCase() !== "active") continue;
    const log = parseLog(node.body);
    const last = log[log.length - 1];
    quests.push(`- ${node.name}: ${node.description}${last ? ` (latest: ${last.text})` : ""}`);
  }
  if (quests.length) parts.push(`Open quests:\n${quests.join("\n")}`);

  const lastNarration = save
    ? [...save.messages]
        .reverse()
        .find(
          (m) => (m as { role?: unknown }).role === "assistant" &&
            typeof (m as { content?: unknown }).content === "string",
        )
    : undefined;
  if (lastNarration) {
    const text = String((lastNarration as { content: string }).content);
    parts.push(`The last scene ended like this:\n${text.slice(-LAST_SCENE_CAP)}`);
  }

  return parts.join("\n\n");
}

/** Kickoff de retomada — substitui a Opening scene quando session.resumed. */
export function resumeKickoff(recap: string): string {
  return (
    "The campaign resumes after a break. RECAP DATA (ground truth — do not " +
    "invent events absent from it):\n\n" +
    recap +
    '\n\nNarrate a brief "Previously…" (2-4 sentences) grounded ONLY in the ' +
    "RECAP DATA, then re-establish the scene exactly where the protagonist " +
    "left off — same place, same company, same unresolved moment. Keep it " +
    "short and end with one concrete hook for my next action. Reveal nothing new."
  );
}
