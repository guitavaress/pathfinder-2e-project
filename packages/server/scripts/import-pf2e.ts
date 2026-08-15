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
  /** `_id` do documento Foundry — resolve @UUID/selfEffect/GrantItem (último segmento). */
  uuid?: string;
  /** `type` Foundry ORIGINAL (a categoria agrupa; o docType preserva — ex.: "ammo" dentro de equipment). */
  docType?: string;
  /** Pack de origem (diretório sob packs/). */
  pack?: string;
  /** `system.rules` VERBATIM — os rule elements. Import é total; consumo é incremental (ADR-007). */
  rules?: unknown[];
  /** Feats: taxonomia NATIVA (system.category): class|ancestry|classfeature|skill|general|pfsboon|deityboon|curse|calling|bonus|ancestryfeature. */
  featCategory?: string;
  /** Feats: pré-requisitos declarados (system.prerequisites.value[].value). */
  prerequisites?: string[];
  /** Feats: uuid do effect que carrega a mecânica de uso (system.selfEffect). */
  selfEffect?: string;
  /** Feats: subfeatures verbatim (proficiências concedidas, keyOptions…). */
  subfeatures?: unknown;
  /** Conditions: aceita valor numérico? (system.value.isValued — frightened 2). */
  conditionValued?: boolean;
  /** Conditions: grupo (ex.: "detection") e condições que esta sobrepõe. */
  conditionGroup?: string;
  overrides?: string[];
  /** Effects: duração estruturada e badge (contador) verbatim. */
  effectDuration?: unknown;
  badge?: unknown;
  /** Hazards: detalhes próprios além do statblock (stealth DC, desarme, rotina). */
  hazard?: {
    stealth: number | null;
    isComplex: boolean;
    disable?: string;
    routine?: string;
    reset?: string;
  };
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
  /** Magias (type "spell"): mecânica estruturada — cast_spell resolve daqui. */
  spell?: SpellMechanics;
}

/** Mecânica estruturada de uma magia (extraída do doc Foundry). */
interface SpellMechanics {
  /** Rank base (system.level.value). Cantrips têm rank 1 + trait "cantrip". */
  rank: number;
  cantrip: boolean;
  /** system.time.value cru: "1" | "2" | "3" | "1 to 3" | "reaction" | "1 minute"… */
  castActions: string;
  /** Trait "attack": spell attack roll contra AC. */
  attack: boolean;
  /** Save do alvo (system.defense.save); basic = metade no sucesso. */
  defense?: { save: string; basic: boolean };
  /** Entradas de dano/cura; kinds distingue "damage" de "healing". */
  damage: { formula: string; type: string; kinds: string[]; category?: string }[];
  /** Heightening por intervalo: +add[i] à damage[i] a cada `interval` ranks. */
  heighten?: { interval: number; add: string[] };
  range?: string;
  area?: string;
  targets?: string;
  duration?: string;
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
  /** Traços da habilidade — fonte dos roll options `item:trait:*`. */
  traits?: string[];
  frequency?: { max: number; per: string };
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

/**
 * Mapeia o `type` do documento Foundry para a nossa categoria — TOTAL.
 *
 * Censo 2026-07-26 (ref 7.8.0, 27.940 docs): a versão antiga devolvia `null`
 * para 8 tipos (~1.650 docs descartados em silêncio — os 1.106 hazards
 * inteiros nunca existiram no dataset) e enterrava ancestries/heritages/
 * classes/deities/EFFECTS num `misc.json` que nenhuma função lia. Import é
 * total: tipo desconhecido agora FALHA o import em vez de sumir — um bump de
 * ref que introduza tipo novo aparece na hora, não como buraco silencioso.
 */
const CATEGORY_OF: Record<string, string> = {
  action: "actions",
  feat: "feats",
  spell: "spells",
  condition: "conditions",
  weapon: "equipment",
  armor: "equipment",
  shield: "equipment",
  equipment: "equipment",
  consumable: "equipment",
  treasure: "equipment",
  backpack: "equipment",
  ammo: "equipment",
  npc: "bestiary",
  hazard: "hazards",
  effect: "effects",
  ancestry: "ancestries",
  heritage: "heritages",
  background: "backgrounds",
  class: "classes",
  deity: "deities",
  campaignFeature: "campaign",
  character: "pregens",
  vehicle: "vehicles",
  army: "armies",
  familiar: "familiars",
  kit: "kits",
  script: "macros",
};

function categoryOf(type: string): string {
  const cat = CATEGORY_OF[type];
  if (!cat) {
    throw new Error(
      `Tipo Foundry desconhecido: "${type}" — mapeie-o em CATEGORY_OF (import é TOTAL, descarte silencioso é proibido).`,
    );
  }
  return cat;
}

/**
 * Tabela de localização do sistema pf2e (`static/lang/en.json`), indexada pelo
 * caminho pontilhado que o `@Localize[...]` referencia.
 *
 * POR QUE ISTO EXISTE (achado de 2026-07-26): `cleanText` APAGAVA o marcador
 * `@Localize` sem substituto, e a descrição inteira de 6.966 habilidades de
 * criatura (22% do bestiary) virava string vazia — o texto de `Grab`,
 * `Ferocity`, `Void Healing`, `Constrict`… simplesmente sumia no import. Não
 * era dado ausente na fonte: era dado que a gente jogava fora. Também mutilava
 * 46 entradas do pack de glossário em `actions.json` (o `Constrict` ficou
 * gravado como `"(0) bludgeoning,"`).
 *
 * O alias de remaster NÃO precisa de tabela: a própria fonte resolve. O doc
 * chamado "Void Healing" traz `@Localize[PF2E.NPC.Abilities.Glossary.NegativeHealing]`,
 * então expandir a chave que ESTÁ no dado basta.
 */
let localization: Record<string, unknown> = {};
/** Contadores do conserto, reportados no manifest (prova, não promessa). */
let localizeHits = 0;
let localizeMisses = 0;
const localizeMissedKeys = new Set<string>();

/** Navega um caminho pontilhado ("PF2E.NPC.Abilities.Glossary"), sem exigir folha. */
function localizeNode(key: string): unknown {
  let node: unknown = localization;
  for (const part of key.split(".")) {
    if (!node || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

/** Resolve um caminho pontilhado até a FOLHA de texto ("…Glossary.Grab"). */
function localizeLookup(key: string): string | null {
  const node = localizeNode(key);
  return typeof node === "string" ? node : null;
}

function loadLocalization(path: string): void {
  if (!existsSync(path)) {
    console.warn(
      `[localize] ${path} não encontrado — @Localize seguirá sendo descartado (texto de habilidade de criatura ficará vazio).`,
    );
    return;
  }
  localization = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const glossary = localizeNode("PF2E.NPC.Abilities.Glossary");
  const n =
    glossary && typeof glossary === "object" ? Object.keys(glossary).length : 0;
  if (n === 0) {
    console.warn(
      `[localize] ${path} carregado, mas SEM PF2E.NPC.Abilities.Glossary — o texto das habilidades de criatura não será recuperado.`,
    );
    return;
  }
  console.log(`[localize] ${path} carregado (${n} chaves de glossário de criatura).`);
}

/** Remove HTML e marcadores do Foundry (@UUID[...]{label}, @Localize, etc.). */
function cleanText(html: unknown): string {
  if (typeof html !== "string") return "";
  return html
    // EXPANDE o @Localize ANTES de tudo: 23 das 55 entradas do glossário de
    // criatura trazem @UUID no próprio texto (e 2 trazem @Damage/@Check), então
    // o resultado da expansão precisa passar por todo o resto do pipeline.
    // Expandir no fim deixaria esses marcadores crus no dado.
    .replace(/@Localize\[([^\]]+)\]/g, (_m, key: string) => {
      const text = localizeLookup(key.trim());
      if (text === null) {
        localizeMisses++;
        localizeMissedKeys.add(key.trim());
        return "";
      }
      localizeHits++;
      return text;
    })
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
      const abTraits = (isys.traits ?? {}) as Record<string, unknown>;
      const abFreq = (isys.frequency ?? null) as Record<string, unknown> | null;
      abilitiesList.push({
        name,
        actionType: typeof atObj.value === "string" && atObj.value ? atObj.value : "passive",
        actions: typeof acObj2.value === "number" ? acObj2.value : null,
        text: cleanText(descObj.value).slice(0, 600),
        // Traços e frequency alimentam os roll options da engine (Fase 2.5):
        // `item:trait:x` só é respondível se o traço vier importado.
        ...(Array.isArray(abTraits.value) && abTraits.value.length > 0
          ? { traits: (abTraits.value as unknown[]).map(String) }
          : {}),
        ...(abFreq && typeof abFreq.max === "number"
          ? {
              frequency: {
                max: abFreq.max,
                per: typeof abFreq.per === "string" ? abFreq.per : "round",
              },
            }
          : {}),
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

/** Extrai a mecânica estruturada de uma magia (type "spell"). */
function extractSpell(
  system: Record<string, unknown>,
  rank: number,
  traits: string[],
): SpellMechanics {
  const timeObj = (system.time ?? {}) as Record<string, unknown>;
  const defObj = (system.defense ?? null) as Record<string, unknown> | null;
  const saveObj = (defObj?.save ?? null) as Record<string, unknown> | null;

  const damageRaw = (system.damage ?? {}) as Record<string, unknown>;
  const damageKeys = Object.keys(damageRaw);
  const damage = damageKeys
    .map((k) => {
      const d = (damageRaw[k] ?? {}) as Record<string, unknown>;
      if (typeof d.formula !== "string" || !d.formula) return null;
      return {
        formula: d.formula,
        type: typeof d.type === "string" ? d.type : "",
        kinds: Array.isArray(d.kinds) ? (d.kinds as unknown[]).map(String) : ["damage"],
        ...(typeof d.category === "string" && d.category
          ? { category: d.category }
          : {}),
      };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);

  // Heightening "interval": add[i] alinhado à damage[i] pela MESMA chave.
  const hObj = (system.heightening ?? null) as Record<string, unknown> | null;
  let heighten: SpellMechanics["heighten"];
  if (hObj?.type === "interval" && typeof hObj.interval === "number") {
    const hDmg = (hObj.damage ?? {}) as Record<string, unknown>;
    const add = damageKeys
      .map((k) => (typeof hDmg[k] === "string" ? (hDmg[k] as string) : ""))
      .filter(Boolean);
    if (add.length > 0) heighten = { interval: hObj.interval, add };
  }

  const str = (v: unknown): string | undefined => {
    const o = (v ?? null) as Record<string, unknown> | null;
    return o && typeof o.value === "string" && o.value ? o.value : undefined;
  };
  const areaObj = (system.area ?? null) as Record<string, unknown> | null;

  return {
    rank,
    cantrip: traits.includes("cantrip"),
    castActions: typeof timeObj.value === "string" ? timeObj.value : "2",
    attack: traits.includes("attack"),
    ...(saveObj && typeof saveObj.statistic === "string"
      ? { defense: { save: saveObj.statistic, basic: saveObj.basic === true } }
      : {}),
    damage,
    ...(heighten ? { heighten } : {}),
    ...(str(system.range) ? { range: str(system.range) } : {}),
    ...(areaObj && typeof areaObj.value === "number" && typeof areaObj.type === "string"
      ? { area: `${areaObj.value}-foot ${areaObj.type}` }
      : {}),
    ...(str(system.target) ? { targets: str(system.target) } : {}),
    ...(str(system.duration) ? { duration: str(system.duration) } : {}),
  };
}

function toRecord(
  doc: Record<string, unknown>,
  source: string,
  pack?: string,
): RuleRecord | null {
  const type = typeof doc.type === "string" ? doc.type : "";
  const name = typeof doc.name === "string" ? doc.name : "";
  // Doc sem type/nome não é regra (ex.: metadocumentos) — contado no manifest.
  if (!type || !name) return null;
  const category = categoryOf(type);

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

  // Mecânica estruturada de MAGIAS: cast_spell resolve dados, não prosa.
  let spell: SpellMechanics | undefined;
  if (type === "spell" && level !== null) {
    const traitList = Array.isArray(traitsObj.value)
      ? (traitsObj.value as unknown[]).map(String)
      : [];
    // Rituais ficam fora (não são conjuráveis em combate).
    if (!traitList.includes("ritual") && !(system.ritual ?? null)) {
      spell = extractSpell(system, level, traitList);
    }
  }

  // Statblock estruturado de CRIATURAS e HAZARDS: AC/HP/saves/ataques reais.
  // Hazards usam o MESMO shape de attributes (ac.value/hp.max) e também têm
  // Strikes embutidos (items type "melee" — a lança da armadilha).
  let statblock: CreatureStatblock | undefined;
  if (type === "npc" || type === "hazard") {
    statblock = extractStatblock(system, doc.items);
  }

  // Detalhes próprios de HAZARD: stealth DC (para Seek), desarme e rotina.
  let hazard: RuleRecord["hazard"];
  if (type === "hazard") {
    const attrs = (system.attributes ?? {}) as Record<string, unknown>;
    const stealthObj = (attrs.stealth ?? {}) as Record<string, unknown>;
    const dis = cleanText((detailsObj.disable ?? "") as string);
    const rou = cleanText((detailsObj.routine ?? "") as string);
    const res = cleanText((detailsObj.reset ?? "") as string);
    hazard = {
      stealth: typeof stealthObj.value === "number" ? stealthObj.value : null,
      isComplex: detailsObj.isComplex === true,
      ...(dis ? { disable: dis } : {}),
      ...(rou ? { routine: rou } : {}),
      ...(res ? { reset: res } : {}),
    };
  }

  // Texto sintetizado quando não há prosa — para NENHUM documento ser filtrado
  // no load (dataset.ts exige `text`; antes isso silenciosamente derrubava 46
  // actions e trocaria "zero perda" por "quase zero perda").
  if (!text) {
    const traitList = Array.isArray(traitsObj.value)
      ? (traitsObj.value as unknown[]).map(String).join(", ")
      : "";
    const rarity = typeof traitsObj.rarity === "string" ? traitsObj.rarity : "common";
    const noun = type === "npc" ? "creature" : type;
    text = `Level ${level ?? "?"} ${rarity} ${noun}.${traitList ? ` Traits: ${traitList}.` : ""}`;
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

  // Rule elements VERBATIM — a mecânica declarativa do Foundry (FlatModifier,
  // DamageDice, GrantItem…). 7.653 docs têm; até 2026-07-26 eram descartados.
  const rules = Array.isArray(system.rules) && system.rules.length > 0
    ? (system.rules as unknown[])
    : undefined;

  // FEATS: taxonomia nativa + pré-requisitos + link para o effect de uso.
  let featCategory: string | undefined;
  let prerequisites: string[] | undefined;
  let selfEffect: string | undefined;
  let subfeatures: unknown;
  if (type === "feat") {
    featCategory = typeof system.category === "string" ? system.category : undefined;
    const preObj = (system.prerequisites ?? {}) as Record<string, unknown>;
    const preList = (Array.isArray(preObj.value) ? preObj.value : [])
      .map((p) => (p as Record<string, unknown>)?.value)
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    if (preList.length > 0) prerequisites = preList;
    const seObj = (system.selfEffect ?? null) as Record<string, unknown> | null;
    if (seObj && typeof seObj.uuid === "string") {
      // Guarda só o _id (último segmento) — é como o uuid-index resolve.
      selfEffect = seObj.uuid.split(".").pop();
    }
    if (
      system.subfeatures &&
      typeof system.subfeatures === "object" &&
      Object.keys(system.subfeatures as object).length > 0
    ) {
      subfeatures = system.subfeatures;
    }
  }

  // CONDITIONS: valor, grupo e sobreposições (frightened É valuada; dying
  // sobrepõe unconscious…). Antes só nome+texto.
  let conditionValued: boolean | undefined;
  let conditionGroup: string | undefined;
  let overrides: string[] | undefined;
  if (type === "condition") {
    const valObj = (system.value ?? {}) as Record<string, unknown>;
    conditionValued = valObj.isValued === true;
    if (typeof system.group === "string" && system.group) conditionGroup = system.group;
    const ov = (Array.isArray(system.overrides) ? system.overrides : []).map(String);
    if (ov.length > 0) overrides = ov;
  }

  // EFFECTS: duração e badge (o contador do efeito) verbatim.
  let effectDuration: unknown;
  let badge: unknown;
  if (type === "effect") {
    if (system.duration) effectDuration = system.duration;
    if (system.badge) badge = system.badge;
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
    ...(typeof doc._id === "string" ? { uuid: doc._id } : {}),
    docType: type,
    ...(pack ? { pack } : {}),
    rules,
    featCategory,
    prerequisites,
    selfEffect,
    subfeatures,
    conditionValued,
    conditionGroup,
    overrides,
    effectDuration,
    badge,
    hazard,
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
    spell,
  };
}

/** Lê todos os *.json sob packs/, com o PACK de origem (1º diretório). */
function readJsonFilesRecursive(
  dir: string,
  pack = "",
): { doc: Record<string, unknown>; pack: string }[] {
  const out: { doc: Record<string, unknown>; pack: string }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...readJsonFilesRecursive(full, pack || entry.name));
    } else if (entry.name.endsWith(".json") && !entry.name.startsWith("_")) {
      try {
        out.push({ doc: JSON.parse(readFileSync(full, "utf8")), pack });
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
    // `static/lang` entra junto: é de onde sai o texto que o @Localize
    // referencia (sem ele, 22% das habilidades de criatura ficam sem descrição).
    execFileSync(
      "git",
      ["-C", tmp, "sparse-checkout", "set", "packs", "static/lang"],
      { stdio: "inherit" },
    );
    const packsDir = join(tmp, "packs");
    if (!existsSync(packsDir)) {
      throw new Error(`'packs/' não encontrado no clone (ref ${GIT_REF}).`);
    }
    loadLocalization(join(tmp, "static", "lang", "en.json"));
    const docs = readJsonFilesRecursive(packsDir);
    sourceDocCount = docs.length;
    return docs
      .map((d) => toRecord(d.doc, "foundry-git", d.pack))
      .filter((r): r is RuleRecord => r !== null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Nº de documentos lidos da fonte (denominador do zero-perda no manifest). */
let sourceDocCount = 0;

/** Fonte local: lê os packs LevelDB da instalação do Foundry. */
async function collectFromLocal(): Promise<RuleRecord[]> {
  const packsDir = join(SYSTEM_PATH, "packs");
  if (!existsSync(packsDir)) {
    throw new Error(
      `PF2E_SYSTEM_PATH inválido: ${packsDir} não existe. Ajuste a env ou use o modo download.`,
    );
  }
  // Na instalação local o arquivo de idioma fica em lang/ (no repo é static/lang/).
  loadLocalization(join(SYSTEM_PATH, "lang", "en.json"));
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
        sourceDocCount += 1;
        const rec = toRecord(value, `foundry-local:${entry.name}`, entry.name);
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

  // selfEffect pode vir por NOME em vez de _id (o Foundry aceita referência de
  // compêndio nomeada: "...Item.Effect: Spirit Power (Flight)"). Normaliza
  // tudo para o _id do effect — o uuid-index resolve num formato só.
  const effectIdByName = new Map<string, string>();
  for (const r of records) {
    if (r.category === "effects" && r.uuid) effectIdByName.set(r.name, r.uuid);
  }
  const idShaped = /^[A-Za-z0-9]{16}$/;
  for (const r of records) {
    if (r.selfEffect && !idShaped.test(r.selfEffect)) {
      const resolved = effectIdByName.get(r.selfEffect);
      if (resolved) r.selfEffect = resolved;
    }
  }


  // Agrupa por categoria e grava um JSON por categoria.
  const byCategory = new Map<string, RuleRecord[]>();
  for (const r of records) {
    const arr = byCategory.get(r.category) ?? [];
    arr.push(r);
    byCategory.set(r.category, arr);
  }

  mkdirSync(OUT_DIR, { recursive: true });
  // Limpa os *.json antigos: categorias renomeadas (misc.json morre com o
  // import total) não podem sobrar como arquivo fantasma no índice.
  for (const f of readdirSync(OUT_DIR)) {
    if (f.endsWith(".json")) rmSync(join(OUT_DIR, f));
  }
  let total = 0;
  for (const [category, arr] of byCategory) {
    writeFileSync(join(OUT_DIR, `${category}.json`), JSON.stringify(arr));
    console.log(`  ${category}: ${arr.length}`);
    total += arr.length;
  }

  // uuid-index: _id → {name, category} — resolve selfEffect/GrantItem/@UUID
  // sem varrer o dataset inteiro.
  const uuidIndex: Record<string, { name: string; category: string }> = {};
  let duplicateUuids = 0;
  for (const r of records) {
    if (!r.uuid) continue;
    if (uuidIndex[r.uuid]) duplicateUuids += 1;
    uuidIndex[r.uuid] = { name: r.name, category: r.category };
  }
  writeFileSync(join(OUT_DIR, "uuid-index.json"), JSON.stringify(uuidIndex));

  // Manifest: a PROVA de zero perda vira artefato que o teste de conformidade
  // lê (sem precisar clonar nada). counts por docType + por categoria/arquivo.
  const byType: Record<string, number> = {};
  const withRules = records.filter((r) => r.rules?.length).length;
  for (const r of records) byType[r.docType ?? "?"] = (byType[r.docType ?? "?"] ?? 0) + 1;
  const manifest = {
    ref: fromLocal ? `local:${SYSTEM_PATH}` : GIT_REF,
    importedAt: new Date().toISOString(),
    sourceDocs: sourceDocCount,
    written: total,
    withRules,
    duplicateUuids,
    byType,
    categories: Object.fromEntries(
      [...byCategory.entries()].map(([c, arr]) => [c, arr.length]),
    ),
    // Prova do conserto do @Localize: quantas referências foram expandidas e
    // quantas não acharam chave. Chave ausente é PERDA — fica nomeada aqui em
    // vez de virar texto vazio silencioso.
    localize: {
      expanded: localizeHits,
      missed: localizeMisses,
      missedKeys: [...localizeMissedKeys].sort().slice(0, 40),
    },
  };
  writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify(manifest, null, 2));

  // Visibilidade de regressão: extração estruturada quebrada aparece aqui.
  const bestiary = byCategory.get("bestiary") ?? [];
  const withStats = bestiary.filter((r) => r.statblock).length;
  console.log(`  bestiary statblocks: ${withStats}/${bestiary.length}`);
  const spells = byCategory.get("spells") ?? [];
  const withSpell = spells.filter((r) => r.spell).length;
  console.log(`  spells estruturadas: ${withSpell}/${spells.length}`);
  console.log(
    `OK: ${total} de ${sourceDocCount} docs gravados (${withRules} com rule elements; uuids duplicados: ${duplicateUuids})`,
  );
  if (sourceDocCount - total > 200) {
    // Docs sem type/nome legítimos são raros; um vão grande é descarte novo.
    throw new Error(
      `Zero-perda violado: ${sourceDocCount - total} documentos da fonte não viraram registro.`,
    );
  }
}

main().catch((err) => {
  console.error("Erro no import:", err instanceof Error ? err.message : err);
  process.exit(1);
});
