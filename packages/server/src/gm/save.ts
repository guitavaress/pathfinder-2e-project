/**
 * Save-game da campanha: `<brain dir>/save.json`, gravado após cada turno
 * completo. Guarda personagem (com inventário já consumido — use_item muta
 * character.equipment), estado mecânico e a cauda do fio narrativo. Tudo
 * fail-safe: save quebrado nunca derruba um turno nem impede um jogo novo.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { CharacterSchema, GameStateSchema } from "@pf2e/shared";
import { z } from "zod";
import { brainDir } from "./brain.js";
import type { Session } from "./sessions.js";

/** Cauda do histórico restaurada no Continue — contexto de 12B é orçamento. */
export const SAVE_MESSAGE_TAIL = 30;

export const SaveGameSchema = z.object({
  version: z.literal(1),
  savedAt: z.string(),
  character: CharacterSchema,
  state: GameStateSchema,
  // Mensagens do SDK OpenAI (user/assistant do fio narrativo) — JSON puro;
  // validadas estruturalmente no restore, não campo a campo.
  messages: z.array(z.record(z.string(), z.unknown())),
});

export type SaveGame = z.infer<typeof SaveGameSchema>;

export function savePath(dir = brainDir()): string {
  return join(dir, "save.json");
}

/** Grava o save da campanha. Erro vira warn — nunca interrompe o turno. */
export function saveSession(session: Session, dir = brainDir()): void {
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const save: SaveGame = {
      version: 1,
      savedAt: new Date().toISOString(),
      character: session.character,
      state: session.state,
      messages: session.messages.slice(-SAVE_MESSAGE_TAIL) as unknown as SaveGame["messages"],
    };
    writeFileSync(savePath(dir), JSON.stringify(save, null, 2));
  } catch (err) {
    console.warn("[save] gravação falhou:", err instanceof Error ? err.message : err);
  }
}

/** Lê e valida o save; qualquer problema (ausente/corrompido) → null + warn. */
export function loadSave(dir = brainDir()): SaveGame | null {
  try {
    const path = savePath(dir);
    if (!existsSync(path)) return null;
    const parsed = SaveGameSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!parsed.success) {
      console.warn("[save] save.json inválido — ignorando:", parsed.error.issues[0]?.message);
      return null;
    }
    return parsed.data;
  } catch (err) {
    console.warn("[save] leitura falhou:", err instanceof Error ? err.message : err);
    return null;
  }
}

/** Restaura o save numa sessão recém-criada (id novo vence o antigo). */
export function restoreIntoSession(session: Session, save: SaveGame): void {
  session.state = { ...save.state, sessionId: session.id, combat: save.state.combat };
  session.messages = save.messages as unknown as ChatCompletionMessageParam[];
  session.resumed = true;
}
