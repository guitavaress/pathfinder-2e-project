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
  /** Criaturas (type "npc"): statblock estruturado — a engine usa AC/HP/ataques
   *  reais em vez do benchmark por nível. Só presente quando AC e HP resolvem. */
  statblock?: CreatureStatblock;
}

/** Um Strike de NPC (item Foundry type "melee" — inclui ataques à distância). */
interface CreatureAttack {
  name: string;
  /** Bônus de ataque (system.bonus.value). */
  bonus: number;
  /** Entradas de dano na ordem do statblock (Object.values de system.damageRolls). */
  damage: { formula: string; type: string; category?: string }[];
  traits: string[];
  /** Presente quando o strike é à distância (system.range.increment). */
  rangeIncrement?: number;
  /** attackEffects (grab, knockdown, filth-fever…) — guardado, não aplicado ainda. */
  effects?: string[];
}

/** Habilidade de NPC (item type "action": passivas, reações, ações especiais). */
interface CreatureAbility {
  name: string;
  actionType: string; // "action" | "reaction" | "free" | "passive"
  actions: number | null;
  text: string;
}

/** Entrada de conjuração de NPC (item type "spellcastingEntry" + spells irmãs). */
interface CreatureSpellcasting {
  name: string;
  tradition: string;
  type: string; // "prepared" | "spontaneous" | "innate" | "focus"
  dc: number;
  attack: number;
  spells: { name: string; rank: number }[];
}

interface CreatureStatblock {
  ac: number;
  hp: number;
  perception: number;
  saves: { fortitude: number; reflex: number; will: number };
  abilities?: Record<string, number>;
  speed?: { land: number; other: { type: string; value: number }[] };
  size?: string;
  senses?: string[];
  immunities?: string[];
  weaknesses?: { type: string; value: number }[];
  resistances?: { type: string; value: number }[];
  attacks: CreatureAttack[];
  abilitiesList: CreatureAbility[];
  spellcasting?: CreatureSpellcasting[];
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
    // @Damage tem colchetes ANINHADOS (@Damage[1d8[healing]]) — o padrão
    // genérico parava no 1º "]" e mutilava o texto ("you regain ] Hit
    // Points"), perdendo a fórmula que a engine lê (use_item).
    .replace(
      /@Damage\[((?:[^\[\]]|\[[^\]]*\])*)\](\{([^}]*)\})?/g,
      (_m, expr: string, _b, label?: string) =>
        label ?? expr.replace(/\[([^\]]*)\]/g, " $1").trim(),
    )
    .replace(/@(Check|Damage|Template)\[[^\]]*\](\{([^}]*)\})?/g, "$3")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&[a-z]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 2000);
}

/**
 * Extrai o statblock estruturado de um NPC. Retorna undefined quando AC ou HP
 * não resolvem (ausência honesta → runtime cai no benchmark; nunca fabricar 0).
 * Nota --from-local: nos packs LevelDB os items podem não vir embutidos no
 * actor — a extração é best-effort e o record fica prose-only.
 */
function extractStatblock(
  system: Record<string, unknown>,
  items: unknown,
): CreatureStatblock | undefined {
  const attrs = (system.attributes ?? {}) as Record<string, unknown>;
  const acObj = (attrs.ac ?? {}) as Record<string, unknown>;
  const hpObj = (attrs.hp ?? {}) as Record<string, unknown>;
  if (typeof acObj.value !== "number" || typeof hpObj.max !== "number") {
    return undefined;
  }

  // 7.8.0: percepção fica em system.perception (não em attributes.perception).
  const percObj = (system.perception ?? {}) as Record<string, unknown>;
  const savesObj = (system.saves ?? {}) as Record<string, unknown>;
  const saveOf = (key: string): number => {
    const o = (savesObj[key] ?? {}) as Record<string, unknown>;
    return typeof o.value === "number" ? o.value : 0;
  };

  const abilitiesObj = (system.abilities ?? {}) as Record<string, unknown>;
  const abilities: Record<string, number> = {};
  for (const [key, raw] of Object.entries(abilitiesObj)) {
    const mod = (raw as Record<string, unknown>)?.mod;
    if (typeof mod === "number") abilities[key] = mod;
  }

  const speedObj = (attrs.speed ?? {}) as Record<string, unknown>;
  const speed =
    typeof speedObj.value === "number"
      ? {
          land: speedObj.value,
          other: (Array.isArray(speedObj.otherSpeeds) ? speedObj.otherSpeeds : [])
            .map((s) => s as Record<string, unknown>)
            .filter((s) => typeof s.type === "string" && typeof s.value === "number")
            .map((s) => ({ type: s.type as string, value: s.value as number })),
        }
      : undefined;

  const senses = (Array.isArray(percObj.senses) ? percObj.senses : [])
    .map((s) => (s as Record<string, unknown>)?.type)
    .filter((t): t is string => typeof t === "string");

  // immunities: [{type}] · weaknesses/resistances: [{type, value}] — ausentes
  // quando vazios, então tudo é defensivo.
  const typeList = (raw: unknown): string[] =>
    (Array.isArray(raw) ? raw : [])
      .map((e) => (e as Record<string, unknown>)?.type)
      .filter((t): t is string => typeof t === "string");
  const typeValueList = (raw: unknown): { type: string; value: number }[] =>
    (Array.isArray(raw) ? raw : [])
      .map((e) => e as Record<string, unknown>)
      .filter((e) => typeof e.type === "string" && typeof e.value === "number")
      .map((e) => ({ type: e.type as string, value: e.value as number }));

  const attacks: CreatureAttack[] = [];
  const abilitiesList: CreatureAbility[] = [];
  const entries = new Map<string, CreatureSpellcasting>();
  const spellsByEntry = new Map<string, { name: string; rank: number }[]>();

  for (const raw of Array.isArray(items) ? items : []) {
    const item = raw as Record<string, unknown>;
    const name = typeof item.name === "string" ? item.name : "";
    const isys = (item.system ?? {}) as Record<string, unknown>;
    if (!name) continue;

    if (item.type === "melee") {
      // "melee" = Strike de NPC (ataques à distância TAMBÉM são type "melee";
      // o discriminador é system.range.increment).
      const bonusObj = (isys.bonus ?? {}) as Record<string, unknown>;
      const damage = Object.values((isys.damageRolls ?? {}) as Record<string, unknown>)
        .map((r) => {
          const o = (r ?? {}) as Record<string, unknown>;
          if (typeof o.damage !== "string" || !o.damage) return null;
          return {
            formula: o.damage,
            type: typeof o.damageType === "string" ? o.damageType : "",
            ...(o.category === "persistent" ? { category: "persistent" } : {}),
          };
        })
        .filter((d): d is CreatureAttack["damage"][number] => d !== null);
      if (typeof bonusObj.value !== "number" || damage.length === 0) continue;

      const traitsObj = (isys.traits ?? {}) as Record<string, unknown>;
      const rangeObj = (isys.range ?? null) as Record<string, unknown> | null;
      const fxObj = (isys.attackEffects ?? {}) as Record<string, unknown>;
      const effects = (Array.isArray(fxObj.value) ? fxObj.value : []).map(String);
      attacks.push({
        name,
        bonus: bonusObj.value,
        damage,
        traits: Array.isArray(traitsObj.value)
          ? (traitsObj.value as unknown[]).map(String)
          : [],
        ...(rangeObj && typeof rangeObj.increment === "number"
          ? { rangeIncrement: rangeObj.increment }
          : {}),
        ...(effects.length > 0 ? { effects } : {}),
      });
    } else if (item.type === "action") {
      const atObj = (isys.actionType ?? {}) as Record<string, unknown>;
      const acObj2 = (isys.actions ?? {}) as Record<string, unknown>;
      const descObj = (isys.description ?? {}) as Record<string, unknown>;
      abilitiesList.push({
        name,
        actionType: typeof atObj.value === "string" && atObj.value ? atObj.value : "passive",
        actions: typeof acObj2.value === "number" ? acObj2.value : null,
        text: cleanText(descObj.value).slice(0, 600),
      });
    } else if (item.type === "spellcastingEntry") {
      const id = typeof item._id === "string" ? item._id : "";
      const dcObj = (isys.spelldc ?? {}) as Record<string, unknown>;
      const tradObj = (isys.tradition ?? {}) as Record<string, unknown>;
      const prepObj = (isys.prepared ?? {}) as Record<string, unknown>;
      if (!id || typeof dcObj.dc !== "number") continue;
      entries.set(id, {
        name,
        tradition: typeof tradObj.value === "string" ? tradObj.value : "",
        type: typeof prepObj.value === "string" ? prepObj.value : "",
        dc: dcObj.dc,
        attack: typeof dcObj.value === "number" ? dcObj.value : 0,
        spells: [],
      });
    } else if (item.type === "spell") {
      const locObj = (isys.location ?? {}) as Record<string, unknown>;
      const lvlObj = (isys.level ?? {}) as Record<string, unknown>;
      const loc = typeof locObj.value === "string" ? locObj.value : "";
      if (!loc) continue;
      const list = spellsByEntry.get(loc) ?? [];
      list.push({ name, rank: typeof lvlObj.value === "number" ? lvlObj.value : 0 });
      spellsByEntry.set(loc, list);
    }
  }

  for (const [id, entry] of entries) {
    entry.spells = spellsByEntry.get(id) ?? [];
  }
  const spellcasting = [...entries.values()];

  const sizeObj = ((system.traits ?? {}) as Record<string, unknown>).size as
    | Record<string, unknown>
    | undefined;

  const immunities = typeList(attrs.immunities);
  const weaknesses = typeValueList(attrs.weaknesses);
  const resistances = typeValueList(attrs.resistances);

  return {
    ac: acObj.value,
    hp: hpObj.max,
    perception: typeof percObj.mod === "number" ? percObj.mod : 0,
    saves: {
      fortitude: saveOf("fortitude"),
      reflex: saveOf("reflex"),
      will: saveOf("will"),
    },
    ...(Object.keys(abilities).length > 0 ? { abilities } : {}),
    ...(speed ? { speed } : {}),
    ...(sizeObj && typeof sizeObj.value === "string" ? { size: sizeObj.value } : {}),
    ...(senses.length > 0 ? { senses } : {}),
    ...(immunities.length > 0 ? { immunities } : {}),
    ...(weaknesses.length > 0 ? { weaknesses } : {}),
    ...(resistances.length > 0 ? { resistances } : {}),
    attacks,
    abilitiesList,
    ...(spellcasting.length > 0 ? { spellcasting } : {}),
  };
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
  // Muitos NPCs não têm prosa nenhuma — sintetizar um texto mínimo para que o
  // record não seja filtrado pelo loader (dataset.ts exige `text`).
  let text = cleanText(description.value) || cleanText(detailsObj.publicNotes);

  // Statblock estruturado de CRIATURAS: AC/HP/saves/ataques reais para a engine.
  let statblock: CreatureStatblock | undefined;
  if (type === "npc") {
    statblock = extractStatblock(system, doc.items);
    if (!text) {
      const traitList = Array.isArray(traitsObj.value)
        ? (traitsObj.value as unknown[]).map(String).join(", ")
        : "";
      const rarity = typeof traitsObj.rarity === "string" ? traitsObj.rarity : "common";
      text = `Level ${level ?? "?"} ${rarity} creature.${traitList ? ` Traits: ${traitList}.` : ""}`;
    }
  }

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
    statblock,
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
  // Visibilidade de regressão: extração de statblock quebrada aparece aqui.
  const bestiary = byCategory.get("bestiary") ?? [];
  const withStats = bestiary.filter((r) => r.statblock).length;
  console.log(`  bestiary statblocks: ${withStats}/${bestiary.length}`);
  console.log(`OK: ${total} entradas gravadas em ${OUT_DIR}`);
}

main().catch((err) => {
  console.error("Erro no import:", err instanceof Error ? err.message : err);
  process.exit(1);
});
