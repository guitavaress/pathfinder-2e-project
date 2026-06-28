import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const seedPath = join(here, "../../data/pf2e/skill-actions.json");
const generatedDir = join(here, "../../data/pf2e/generated");

/** Registro unificado de regra (gerado por `npm run data:pf2e` ou do seed). */
export interface RuleRecord {
  name: string;
  category: string;
  traits?: string[];
  level?: number | null;
  rarity?: string | null;
  text: string;
  source: string;
}

interface SeedAction {
  id: string;
  name: string;
  skill: string;
  summary: string;
  criticalSuccess?: string;
  success?: string;
  failure?: string;
  criticalFailure?: string;
}

let index: RuleRecord[] | null = null;
let byName: Map<string, RuleRecord> | null = null;
let sourceLabel = "seed";

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

function loadSeed(): RuleRecord[] {
  try {
    const data = JSON.parse(readFileSync(seedPath, "utf8")) as {
      actions: SeedAction[];
    };
    return data.actions.map((a) => ({
      name: a.name,
      category: "actions",
      text: [
        a.summary,
        a.criticalSuccess ? `Sucesso crítico: ${a.criticalSuccess}` : "",
        a.success ? `Sucesso: ${a.success}` : "",
        a.failure ? `Falha: ${a.failure}` : "",
        a.criticalFailure ? `Falha crítica: ${a.criticalFailure}` : "",
      ]
        .filter(Boolean)
        .join(" "),
      source: "seed",
    }));
  } catch {
    return [];
  }
}

function loadGenerated(): RuleRecord[] {
  const out: RuleRecord[] = [];
  for (const file of readdirSync(generatedDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const arr = JSON.parse(
        readFileSync(join(generatedDir, file), "utf8"),
      ) as RuleRecord[];
      out.push(...arr);
    } catch {
      // ignora arquivo inválido
    }
  }
  return out;
}

function load(): RuleRecord[] {
  if (index) return index;
  if (existsSync(generatedDir)) {
    index = loadGenerated();
    sourceLabel = `foundry-generated (${index.length} entradas)`;
  }
  if (!index || index.length === 0) {
    index = loadSeed();
    sourceLabel = "seed (rode `npm run data:pf2e` para a base completa)";
  }
  byName = new Map();
  for (const r of index) {
    const key = normalize(r.name);
    // Mantém o primeiro (evita sobrescrever com variantes homônimas).
    if (!byName.has(key)) byName.set(key, r);
  }
  return index;
}

/**
 * Busca uma regra por nome (qualquer categoria). Estratégia: nome exato →
 * substring → maior sobreposição de tokens. Retorna a melhor ou `null`.
 */
export function lookupLocalRule(query: string): RuleRecord | null {
  const all = load();
  const q = normalize(query);
  if (!q) return null;

  // 1. Nome exato.
  const exact = byName!.get(q);
  if (exact) return exact;

  // 2. Substring (prefere o nome mais curto = match mais específico).
  let best: RuleRecord | null = null;
  let bestLen = Infinity;
  for (const r of all) {
    const n = normalize(r.name);
    if (n.includes(q) || q.includes(n)) {
      if (n.length < bestLen) {
        best = r;
        bestLen = n.length;
      }
    }
  }
  if (best) return best;

  // 3. Sobreposição de tokens.
  const qTokens = new Set(q.split(/\s+/).filter((t) => t.length > 2));
  if (qTokens.size === 0) return null;
  let bestScore = 0;
  for (const r of all) {
    const nTokens = normalize(r.name).split(/\s+/);
    let score = 0;
    for (const t of nTokens) if (qTokens.has(t)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  return bestScore > 0 ? best : null;
}

export function datasetSource(): string {
  load();
  return sourceLabel;
}
