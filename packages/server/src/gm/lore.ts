import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const cache = new Map<string, string | null>();

/** Reads a repo-root markdown file once (memoized). `null` if absent/empty. */
function loadFile(envVar: string, relPath: string): string | null {
  const key = `${envVar}|${relPath}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const path =
    process.env[envVar] ?? fileURLToPath(new URL(relPath, import.meta.url));
  let value: string | null;
  try {
    value = readFileSync(path, "utf8").trim() || null;
  } catch {
    value = null;
  }
  cache.set(key, value);
  return value;
}

/**
 * GM-ONLY secrets (`LORE.md`) — the cosmic truth the player must NOT be handed.
 * Injected into the narrative system prompt as background the GM may hint at but
 * never reveal or dump. Path via `LORE_PATH`. Returns `null` if absent.
 */
export function loadLore(): string | null {
  return loadFile("LORE_PATH", "../../../../LORE.md");
}

/**
 * Player-facing setting primer + authored opening scene (`WORLD.md`) — the
 * surface world the character knows; safe to reveal naturally through play.
 * Path via `WORLD_PATH`. Returns `null` if absent.
 */
export function loadWorld(): string | null {
  return loadFile("WORLD_PATH", "../../../../WORLD.md");
}
