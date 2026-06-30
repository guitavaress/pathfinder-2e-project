import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let cached: string | null | undefined;

/**
 * Loads the project root's `LORE.md` (setting + GM guidelines).
 * Path configurable via `LORE_PATH`. Returns `null` if absent.
 * The content goes into the GM's system prompt — GM-only secrets never reach the player.
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
