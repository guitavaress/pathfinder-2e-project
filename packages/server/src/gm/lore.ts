import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let cached: string | null | undefined;

/**
 * Carrega o `LORE.md` da raiz do projeto (cenário + diretrizes do Mestre).
 * Caminho configurável por `LORE_PATH`. Retorna `null` se ausente.
 * O conteúdo entra no system prompt do GM — segredos só-GM não vão ao jogador.
 */
export function loadLore(): string | null {
  if (cached !== undefined) return cached;
  const path =
    process.env.LORE_PATH ??
    fileURLToPath(new URL("../../../../LORE.md", import.meta.url));
  try {
    cached = readFileSync(path, "utf8").trim() || null;
  } catch {
    cached = null;
  }
  return cached;
}
