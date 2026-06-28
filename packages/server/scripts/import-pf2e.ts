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
    .replace(/@(UUID|Compendium)\[[^\]]+\]/g, "")
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
