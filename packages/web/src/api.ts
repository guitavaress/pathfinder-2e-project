import type { Character, CheckResult, GameState } from "@pf2e/shared";

export interface ImportResult {
  sessionId: string;
  character: Character;
  state: GameState;
}

/** Espelha o StreamEvent do servidor (packages/server/src/gm/agent.ts). */
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "check"; result: CheckResult }
  | { type: "state"; state: GameState }
  | { type: "done" }
  | { type: "error"; message: string };

export async function importCharacter(rawJson: string): Promise<ImportResult> {
  const res = await fetch("/character/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: rawJson,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error ?? `Falha ao importar (HTTP ${res.status}).`);
  }
  return (await res.json()) as ImportResult;
}

/**
 * Executa um turno e consome o stream SSE, chamando `onEvent` para cada evento.
 * `text` vazio inicia a cena de abertura.
 */
export async function streamTurn(
  sessionId: string,
  text: string,
  onEvent: (e: StreamEvent) => void,
): Promise<void> {
  const res = await fetch("/scene/turn", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, text }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`Falha no turno (HTTP ${res.status}).`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // Eventos SSE são separados por linha em branco.
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() ?? "";
    for (const chunk of chunks) {
      const line = chunk.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      const json = line.slice(5).trim();
      if (!json) continue;
      try {
        onEvent(JSON.parse(json) as StreamEvent);
      } catch {
        // ignora linhas malformadas
      }
    }
  }
}
