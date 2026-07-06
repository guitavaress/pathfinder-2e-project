/**
 * Importa o dataset de regras do PF2e (Foundry VTT pf2e) para um índice local
 * pesquisável em `packages/server/data/pf2e/generated/`.
 *
 * Fontes:
 *  - Padrão (download): sparse clone de `foundryvtt/pf2e` (packs em JSON puro)
 *    num ref fixável (`PF2E_GIT_REF`). Requer `git` no sistema.
 *  - Local (opcional): `--from-local` / `PF2E_SYSTEM_PATH` lê a instalação do
 *    Foundry (packs em LevelDB; requer `classic-level` e o Foundry FECHADO).
 *
 * Uso:
 *   npm run data:pf2e
 *   npm run data:pf2e -- --from-local
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(here, "../data/pf2e/generated");

const GIT_REPO = process.env.PF2E_GIT_REPO ?? "https://github.com/foundryvtt/pf2e.git";
const GIT_REF = process.env.PF2E_GIT_REF ?? "7.8.0";
const SYSTEM_PATH =
  process.env.PF2E_SYSTEM_PATH ??
  "/mnt/c/Users/gui_t/AppData/Local/FoundryVTT/Data/systems/pf2e";

interface RuleRecord {
  name: string;
  category: string;
  traits: string[];
  level: number | null;
  rarity: string | null;
  text: string;
  source: string;
  /** Foundry system.actionType.value: "action" | "reaction" | "free" | "passive" (null p/ docs sem ação). */
  actionType: string | null;
  /** Foundry system.actions.value: 1 | 2 | 3 (null p/ reaction/free/passive). */
  actionCost: number | null;
  /** Foundry system.frequency: limite de uso ("once per round/day"...). per: "round"|"turn"|"day"|"PT1H"|... */
  frequency?: { max: number; per: string };
  /** Armas (inclui bombas): dano estruturado de system.damage. */
  damage?: { dice: number; die: string; type: string };
  /** Dano persistente embutido (system.damage.persistent — ex.: alchemist's fire). */
  persistent?: { number: number; faces: number | null; type: string };
  /** Splash damage (system.splashDamage.value) quando > 0. */
  splash?: number;
  /** Bônus de item no ataque (system.bonus.value) quando != 0. */
  bonus?: number;
  /** Alcance em pés (system.range) para armas de arremesso/distância. */
  range?: number;
  /** Categoria de proficiência da ARMA: "simple" | "martial" | "advanced" | "unarmed". */
  weaponCategory?: string;
}

/** Mapeia o `type` do documento Foundry para a nossa categoria. */
function categoryOf(type: string): string | null {
  switch (type) {
    case "action":
      return "actions";
    case "feat":
      return "feats";
    case "spell":
      return "spells";
    case "condition":
      return "conditions";
    case "weapon":
    case "armor":
    case "shield":
    case "equipment":
    case "consumable":
    case "treasure":
    case "backpack":
      return "equipment";
    case "npc":
      return "bestiary";
    case "ancestry":
    case "heritage":
    case "background":
    case "class":
    case "deity":
    case "campaignFeature":
    case "effect":
      return "misc";
    default:
      return null;
  }
}

/** Remove HTML e marcadores do Foundry (@UUID[...]{label}, @Localize, etc.). */
function cleanText(html: unknown): string {
  if (typeof html !== "string") return "";
  return html
    .replace(/@(UUID|Compendium)\[[^\]]+\]\{([^}]*)\}/g, "$2")
    // Sem label: o Foundry renderiza o NOME do documento — recuperar o último
    // segmento do path quando ele é um nome legível (descarta hashes de id).
    // Perder isso mutila o texto ("You can  with a mere glare" sem "Demoralize").
    .replace(/@(UUID|Compendium)\[([^\]]+)\]/g, (_m, _k, path: string) => {
      const seg = (path.split(".").pop() ?? "").trim();
      return /^[A-Z][\w' -]*$/.test(seg) && !/^[A-Za-z0-9]{16}$/.test(seg)
        ? seg.replace(/-/g, " ")
        : "";
    })
    .replace(/@Localize\[[^\]]+\]/g, "")
    .replace(/@(Check|Damage|Template)\[[^\]]*\](\{([^}]*)\})?/g, "$3")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}

function toRecord(doc: Record<string, unknown>, source: string): RuleRecord | null {
  const type = typeof doc.type === "string" ? doc.type : "";
  const category = categoryOf(type);
  const name = typeof doc.name === "string" ? doc.name : "";
  if (!category || !name) return null;

  const system = (doc.system ?? {}) as Record<string, unknown>;
  const description = (system.description ?? {}) as Record<string, unknown>;
  const traitsObj = (system.traits ?? {}) as Record<string, unknown>;
  const levelObj = (system.level ?? {}) as Record<string, unknown>;
  const detailsObj = (system.details ?? {}) as Record<string, unknown>;
  const detailsLevel = (detailsObj.level ?? {}) as Record<string, unknown>;

  const level =
    typeof levelObj.value === "number"
      ? levelObj.value
      : typeof detailsLevel.value === "number"
        ? detailsLevel.value
        : null;

  // NPCs guardam a prosa em system.details.publicNotes, não em description.value.
  const text =
    cleanText(description.value) || cleanText(detailsObj.publicNotes);

  // Custo de ação (feats/actions): separa "tem custo no encounter" de passivo.
  const actionTypeObj = (system.actionType ?? {}) as Record<string, unknown>;
  const actionsObj = (system.actions ?? {}) as Record<string, unknown>;
  const actionType =
    typeof actionTypeObj.value === "string" && actionTypeObj.value
      ? actionTypeObj.value
      : null;
  const actionCost =
    typeof actionsObj.value === "number" ? actionsObj.value : null;

  // Frequency ("once per round/day"): {max, per} — per pode ser palavra ("round",
  // "day") ou duração ISO-8601 ("PT1H"). Só grava quando o doc declara.
  const freqObj = (system.frequency ?? {}) as Record<string, unknown>;
  const frequency =
    typeof freqObj.max === "number" && typeof freqObj.per === "string"
      ? { max: freqObj.max, per: freqObj.per }
      : undefined;

  // Statblock estruturado de ARMAS (inclui bombas alquímicas): dano, splash,
  // persistente, bônus de item, alcance e categoria de proficiência. A engine
  // usa isso em vez de pedir ao modelo para interpretar a prosa.
  let damage: RuleRecord["damage"];
  let persistent: RuleRecord["persistent"];
  let splash: number | undefined;
  let bonus: number | undefined;
  let range: number | undefined;
  let weaponCategory: string | undefined;
  if (type === "weapon") {
    const dmg = (system.damage ?? {}) as Record<string, unknown>;
    if (typeof dmg.die === "string" && typeof dmg.dice === "number" && dmg.die) {
      damage = {
        dice: dmg.dice,
        die: dmg.die,
        type: typeof dmg.damageType === "string" ? dmg.damageType : "",
      };
    }
    const pers = (dmg.persistent ?? null) as Record<string, unknown> | null;
    if (pers && typeof pers.number === "number" && typeof pers.type === "string") {
      persistent = {
        number: pers.number,
        faces: typeof pers.faces === "number" ? pers.faces : null,
        type: pers.type,
      };
    }
    const splashObj = (system.splashDamage ?? {}) as Record<string, unknown>;
    if (typeof splashObj.value === "number" && splashObj.value > 0) {
      splash = splashObj.value;
    }
    const bonusObj = (system.bonus ?? {}) as Record<string, unknown>;
    if (typeof bonusObj.value === "number" && bonusObj.value !== 0) {
      bonus = bonusObj.value;
    }
    if (typeof system.range === "number" && system.range > 0) {
      range = system.range;
    }
    if (typeof system.category === "string" && system.category) {
      weaponCategory = system.category;
    }
  }

  return {
    name,
    category,
    traits: Array.isArray(traitsObj.value)
      ? (traitsObj.value as unknown[]).map(String)
      : [],
    level,
    rarity: typeof traitsObj.rarity === "string" ? traitsObj.rarity : null,
    text,
    source,
    actionType,
    actionCost,
    // Opcionais ficam `undefined` quando ausentes → JSON.stringify os omite
    // (evita inflar os 26k registros com nulls).
    frequency,
    damage,
    persistent,
    splash,
    bonus,
    range,
    weaponCategory,
  };
}

/** Lê todos os *.json sob um diretório, recursivamente. */
function readJsonFilesRecursive(dir: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...readJsonFilesRecursive(full));
    } else if (entry.name.endsWith(".json") && !entry.name.startsWith("_")) {
      try {
        out.push(JSON.parse(readFileSync(full, "utf8")));
      } catch {
        // ignora arquivos não-JSON ou inválidos
      }
    }
  }
  return out;
}

/** Fonte download: sparse clone do repo e leitura dos packs em JSON. */
function collectFromGit(): RuleRecord[] {
  const tmp = mkdtempSync(join(tmpdir(), "pf2e-"));
  try {
    console.log(`Clonando ${GIT_REPO} @ ${GIT_REF} (apenas packs/)…`);
    execFileSync(
      "git",
      [
        "clone",
        "--depth",
        "1",
        "--filter=blob:none",
        "--sparse",
        "--branch",
        GIT_REF,
        GIT_REPO,
        tmp,
      ],
      { stdio: "inherit" },
    );
    execFileSync("git", ["-C", tmp, "sparse-checkout", "set", "packs"], {
      stdio: "inherit",
    });
    const packsDir = join(tmp, "packs");
    if (!existsSync(packsDir)) {
      throw new Error(`'packs/' não encontrado no clone (ref ${GIT_REF}).`);
    }
    const docs = readJsonFilesRecursive(packsDir);
    return docs
      .map((d) => toRecord(d, "foundry-git"))
      .filter((r): r is RuleRecord => r !== null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Fonte local: lê os packs LevelDB da instalação do Foundry. */
async function collectFromLocal(): Promise<RuleRecord[]> {
  const packsDir = join(SYSTEM_PATH, "packs");
  if (!existsSync(packsDir)) {
    throw new Error(
      `PF2E_SYSTEM_PATH inválido: ${packsDir} não existe. Ajuste a env ou use o modo download.`,
    );
  }
  // Import dinâmico via specifier não-literal: o pacote é opcional e pode não
  // estar instalado; só é necessário neste modo.
  const spec = "classic-level";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  try {
    mod = await import(spec);
  } catch {
    throw new Error(
      "Modo --from-local requer 'classic-level'. Instale com: npm i classic-level -w @pf2e/server",
    );
  }
  const ClassicLevel = mod.ClassicLevel as new (
    location: string,
    options: { valueEncoding: string },
  ) => {
    values(): AsyncIterable<Record<string, unknown>>;
    close(): Promise<void>;
  };
  const records: RuleRecord[] = [];
  for (const entry of readdirSync(packsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const db = new ClassicLevel(join(packsDir, entry.name), {
      valueEncoding: "json",
    });
    try {
      for await (const value of db.values()) {
        const rec = toRecord(value, `foundry-local:${entry.name}`);
        if (rec) records.push(rec);
      }
    } catch (err) {
      console.warn(`Falha ao ler pack ${entry.name}:`, (err as Error).message);
    } finally {
      await db.close();
    }
  }
  return records;
}

async function main() {
  const fromLocal = process.argv.includes("--from-local");
  console.log(
    fromLocal
      ? `Importando do Foundry local: ${SYSTEM_PATH}`
      : "Importando via download do repo foundryvtt/pf2e",
  );

  const records = fromLocal ? await collectFromLocal() : collectFromGit();
  if (records.length === 0) {
    throw new Error("Nenhum registro extraído — verifique a fonte.");
  }

  // Agrupa por categoria e grava um JSON por categoria.
  const byCategory = new Map<string, RuleRecord[]>();
  for (const r of records) {
    const arr = byCategory.get(r.category) ?? [];
    arr.push(r);
    byCategory.set(r.category, arr);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  let total = 0;
  for (const [category, arr] of byCategory) {
    writeFileSync(join(OUT_DIR, `${category}.json`), JSON.stringify(arr));
    console.log(`  ${category}: ${arr.length}`);
    total += arr.length;
  }
  console.log(`OK: ${total} entradas gravadas em ${OUT_DIR}`);
}

main().catch((err) => {
  console.error("Erro no import:", err instanceof Error ? err.message : err);
  process.exit(1);
});
