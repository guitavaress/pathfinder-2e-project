/**
 * Dano tipado: imunidade, fraqueza e resistência (PF2e Player Core / GM Core).
 *
 * Módulo PURO — não carrega o dataset em runtime, para que `gm/combat.ts` possa
 * importá-lo sem quebrar a pureza dele. O dado (`CreatureStatblock`) já traz
 * `immunities`/`weaknesses`/`resistances`; aqui mora só a aritmética RAW.
 *
 * Ordem RAW por instância de dano: **imunidade → fraqueza → resistência**, e de
 * cada uma vale apenas a MAIOR aplicável. O dobro do crítico acontece antes
 * (nos call sites), então a resistência incide sobre o valor já dobrado.
 */

/** Rótulo do dano sem tipo declarado. */
export const UNTYPED = "untyped";

/**
 * Categorias que a engine consegue isolar em parcela própria. Sem parcela
 * separada não há como aplicar "imune a precisão" (464 criaturas) sem zerar o
 * ataque inteiro.
 */
export type DamageCategory = "precision" | "splash";

/** Uma parcela de dano de uma mesma instância (1 Strike pode ter várias). */
export interface DamageParcel {
  amount: number;
  /** Tipo PF2e; `"damage"`/`""` (sentinela do benchmark) contam como untyped. */
  type: string;
  category?: DamageCategory;
}

export interface Defenses {
  immunities?: string[];
  weaknesses?: { type: string; value: number }[];
  resistances?: { type: string; value: number }[];
}

export interface DamageAdjustment {
  /** Soma das parcelas ANTES das defesas. */
  raw: number;
  /** O que efetivamente sai do HP. */
  applied: number;
  notes: string[];
  /** `notes` já formatado para o resumo mecânico (`""` quando não houve ajuste). */
  note: string;
}

/** Tipos de dano concretos do PF2e (remaster). */
export const DAMAGE_TYPES = new Set([
  // físicos
  "bludgeoning",
  "piercing",
  "slashing",
  "bleed",
  // energia
  "acid",
  "cold",
  "electricity",
  "fire",
  "force",
  "sonic",
  "vitality",
  "void",
  // demais
  "mental",
  "poison",
  "spirit",
  "holy",
  "unholy",
  "radiation",
  // elementais (kineticist) — tipos próprios, sem meta acima deles
  "air",
  "earth",
  "metal",
  "water",
  "wood",
]);

/** Metatipos com hierarquia resolvida: cobrem os tipos concretos abaixo deles. */
const META_TYPES: Record<string, string[]> = {
  // Bleed é dano físico (GM Core), então resistência a `physical` também o cobre.
  physical: ["bludgeoning", "piercing", "slashing", "bleed"],
  energy: ["acid", "cold", "electricity", "fire", "force", "sonic", "vitality", "void"],
};

/** Metatipo que cobre tudo, inclusive untyped. */
const ALL_DAMAGE = "all-damage";

/** Chave de defesa correspondente a cada categoria isolável. */
const CATEGORY_KEY: Record<DamageCategory, string> = {
  precision: "precision",
  splash: "splash-damage",
};

/**
 * Entradas que SÃO sobre dano mas exigem contexto que a engine não modela
 * (material da arma, se veio de área, se a fonte é mágica…). Ficam DECLARADAS,
 * nunca aplicadas silenciosamente — `classifyDefense` as reporta e o teste de
 * conformidade mede quantas criaturas dependem delas.
 *
 * `critical-hits` está aqui de propósito: em PF2e imunidade a crítico não zera
 * dano, faz o crítico virar acerto normal. É outra mecânica, não uma subtração.
 */
export const UNSUPPORTED_DEFENSES = new Set([
  "alchemical",
  "area-damage",
  "arrow-vulnerability",
  "axe-vulnerability",
  "cold-iron",
  "critical-hits",
  "ghost-touch",
  "healing",
  "light",
  "magic",
  "mythic",
  "non-magical",
  "nonlethal-attacks",
  "object-immunities",
  "orichalcum",
  "peachwood",
  "persistent-damage",
  "plant",
  "protean-anatomy",
  "salt",
  "salt-water",
  "silver",
  "spell-deflection",
  "spells",
  "swarm-attacks",
  "vampire-weaknesses",
  "vorpal",
  "vulnerable-to-sunlight",
]);

/**
 * Entradas que não são dano — imunidade a condição/efeito (`paralyzed`,
 * `death-effects`…). Pertencem a outro subsistema; ignorá-las aqui é correto,
 * não é ponto cego. Listadas para que uma entrada NOVA e desconhecida apareça
 * no teste de conformidade em vez de sumir.
 */
export const NON_DAMAGE_DEFENSES = new Set([
  "aging",
  "auditory",
  "blinded",
  "clumsy",
  "confused",
  "controlled",
  "curse",
  "dazzled",
  "deafened",
  "death-effects",
  "detection",
  "disease",
  "doomed",
  "drained",
  "emotion",
  "enfeebled",
  "fascinated",
  "fatigued",
  "fear",
  "fear-effects",
  "fortune-effects",
  "frightened",
  "grabbed",
  "illusion",
  "immobilized",
  "inhaled",
  "misfortune-effects",
  "off-guard",
  "olfactory",
  "paralyzed",
  "petrified",
  "polymorph",
  "possession",
  "prediction",
  "prone",
  "restrained",
  "scrying",
  "sickened",
  "sleep",
  "slowed",
  "stunned",
  "stupefied",
  "swarm-mind",
  "trip",
  "unconscious",
  "visual",
]);

/** Nomes pré-remaster que ainda aparecem em fichas e prosa. */
const ALIASES: Record<string, string> = {
  positive: "vitality",
  negative: "void",
  good: "holy",
  evil: "unholy",
  "negative-energy": "void",
  "positive-energy": "vitality",
  // Abreviações do export do Pathbuilder (`Weapon.damageType` é "P", não
  // "piercing"). Sem expandir, a arma da ficha nunca casa com a fraqueza do
  // alvo nem com `item:damage:type:*` do dado.
  p: "piercing",
  s: "slashing",
  b: "bludgeoning",
};

/** Normaliza para o vocabulário do dataset: minúsculo, hifenizado, sem alias. */
export function normalizeDamageType(raw: string | null | undefined): string {
  const s = String(raw ?? "")
    .toLowerCase()
    .trim()
    .replace(/^persistent\s+/, "")
    .replace(/\s+damage$/, "")
    .replace(/\s+/g, "-");
  if (!s || s === "damage" || s === UNTYPED) return UNTYPED;
  return ALIASES[s] ?? s;
}

export type DefenseClass = "damage-type" | "meta" | "category" | "unsupported" | "not-damage";

/**
 * Diz em que balde uma entrada de defesa cai. O teste de conformidade varre o
 * bestiário com isto: entrada nova que não caia em nenhum balde conhecido
 * quebra o teste em vez de ser ignorada em silêncio.
 */
export function classifyDefense(entry: string): DefenseClass | "unknown" {
  const t = normalizeDamageType(entry);
  if (DAMAGE_TYPES.has(t)) return "damage-type";
  if (t === ALL_DAMAGE || t in META_TYPES) return "meta";
  if (t === "precision" || t === "splash-damage") return "category";
  if (UNSUPPORTED_DEFENSES.has(t)) return "unsupported";
  if (NON_DAMAGE_DEFENSES.has(t)) return "not-damage";
  return "unknown";
}

/** As chaves de defesa às quais uma parcela responde (tipo + metas + categoria). */
function keysFor(parcel: DamageParcel): Set<string> {
  const keys = new Set<string>([ALL_DAMAGE]);
  const t = normalizeDamageType(parcel.type);
  if (t !== UNTYPED) {
    keys.add(t);
    for (const [meta, members] of Object.entries(META_TYPES)) {
      if (members.includes(t)) keys.add(meta);
    }
  }
  if (parcel.category) keys.add(CATEGORY_KEY[parcel.category]);
  return keys;
}

/** A maior entrada aplicável (RAW: só a maior vale, não a soma). */
function best(
  entries: { type: string; value: number }[] | undefined,
  keys: Set<string>,
): { type: string; value: number } | null {
  let hit: { type: string; value: number } | null = null;
  for (const e of entries ?? []) {
    if (!keys.has(normalizeDamageType(e.type))) continue;
    if (!hit || e.value > hit.value) hit = { type: normalizeDamageType(e.type), value: e.value };
  }
  return hit;
}

/**
 * Aplica imunidade/fraqueza/resistência a uma instância de dano.
 *
 * Parcelas de mesmo tipo+categoria são somadas ANTES: fraqueza e resistência
 * valem uma vez por instância, não uma vez por parcela.
 */
export function adjustDamage(
  parcels: DamageParcel[],
  defenses: Defenses | undefined,
): DamageAdjustment {
  const merged = new Map<string, DamageParcel>();
  let raw = 0;
  for (const p of parcels) {
    const amount = Math.max(0, Math.floor(p.amount));
    raw += amount;
    const key = `${normalizeDamageType(p.type)}|${p.category ?? ""}`;
    const cur = merged.get(key);
    if (cur) cur.amount += amount;
    else merged.set(key, { amount, type: normalizeDamageType(p.type), category: p.category });
  }

  const immunities = (defenses?.immunities ?? []).map(normalizeDamageType);
  const notes: string[] = [];
  let applied = 0;

  for (const p of merged.values()) {
    if (p.amount <= 0) continue;
    const keys = keysFor(p);

    const immune = immunities.find((i) => keys.has(i));
    if (immune) {
      notes.push(`immune to ${immune}`);
      continue;
    }

    let amount = p.amount;
    const weak = best(defenses?.weaknesses, keys);
    if (weak) {
      amount += weak.value;
      notes.push(`weakness ${weak.type} +${weak.value}`);
    }
    const resist = best(defenses?.resistances, keys);
    if (resist) {
      const before = amount;
      amount = Math.max(0, amount - resist.value);
      notes.push(`resistance ${resist.type} -${before - amount}`);
    }
    applied += amount;
  }

  return { raw, applied, notes, note: notes.length ? ` [${notes.join("; ")}]` : "" };
}

/**
 * Escala parcelas por um multiplicador PRESERVANDO o total pedido. PF2e dobra
 * ou reduz pela metade o TOTAL da instância, não cada parcela — arredondar
 * parcela a parcela mudaria o número que a engine já produz hoje.
 */
export function scaleParcels(parcels: DamageParcel[], target: number): DamageParcel[] {
  const raw = parcels.reduce((s, p) => s + Math.max(0, p.amount), 0);
  if (raw <= 0 || target <= 0) return parcels.map((p) => ({ ...p, amount: 0 }));
  const scaled = parcels.map((p) => ({
    ...p,
    amount: Math.floor((Math.max(0, p.amount) * target) / raw),
  }));
  // O resto do arredondamento vai para a maior parcela: o total bate exatamente.
  let rest = target - scaled.reduce((s, p) => s + p.amount, 0);
  while (rest > 0) {
    let biggest = 0;
    for (let i = 1; i < scaled.length; i++) {
      if (scaled[i]!.amount > scaled[biggest]!.amount) biggest = i;
    }
    scaled[biggest]!.amount += 1;
    rest -= 1;
  }
  return scaled;
}

/**
 * Lê as resistências da ficha (Pathbuilder manda `string[]` cru, ex.: "Fire 5").
 * Entrada sem valor numérico não vira resistência — devolvida em `unparsed`
 * para ficar declarada em vez de virar 0 silencioso.
 */
export function parsePlayerResistances(raw: string[] | undefined): {
  resistances: { type: string; value: number }[];
  unparsed: string[];
} {
  const resistances: { type: string; value: number }[] = [];
  const unparsed: string[] = [];
  for (const entry of raw ?? []) {
    const m = /^(?:resistance\s+to\s+)?(.+?)\s+(\d+)$/i.exec(String(entry).trim());
    if (!m) {
      if (String(entry).trim()) unparsed.push(String(entry).trim());
      continue;
    }
    const type = normalizeDamageType(m[1]);
    if (classifyDefense(type) === "unknown" || classifyDefense(type) === "not-damage") {
      unparsed.push(String(entry).trim());
      continue;
    }
    resistances.push({ type, value: Number(m[2]) });
  }
  return { resistances, unparsed };
}
