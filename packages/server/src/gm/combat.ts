import { randomUUID } from "node:crypto";
import type { Character, Combat, Combatant, Companion, DegreeOfSuccess } from "@pf2e/shared";
// Import de TIPO apenas: combat.ts segue puro (nunca carrega o dataset em runtime).
import type { CreatureStatblock } from "../rules/dataset.js";
import { degreeOfSuccess } from "../dice/check.js";
import {
  adjustDamage,
  parsePlayerResistances,
  UNTYPED,
  type DamageAdjustment,
  type DamageParcel,
  type Defenses,
} from "../rules/damage.js";
import { ModifierStack, type Modifier } from "../rules/modifiers.js";
import type { RollOptions } from "../rules/roll-options.js";

/** Rolls `n` dice with `faces` sides and returns the total. */
export function rollDice(n: number, faces: number): number {
  let total = 0;
  for (let i = 0; i < n; i++) total += 1 + Math.floor(Math.random() * faces);
  return total;
}

/** A single d20. */
export function d20(): number {
  return 1 + Math.floor(Math.random() * 20);
}

/**
 * PF2e "moderate" creature benchmarks (GMG) used as fallback stats when we can't
 * look up a real statblock. Values are approximate but plausible for the level.
 */
interface Benchmark {
  ac: number;
  hp: number;
  perception: number;
  attack: number;
  /** Strike damage as {dice}d{faces}+{bonus}. */
  damage: { dice: number; faces: number; bonus: number };
}

// Level -1 .. 12 (indexed by level+1). Kept compact on purpose.
const BENCHMARKS: Benchmark[] = [
  { ac: 15, hp: 9, perception: 5, attack: 6, damage: { dice: 1, faces: 4, bonus: 1 } }, // -1
  { ac: 16, hp: 17, perception: 6, attack: 8, damage: { dice: 1, faces: 6, bonus: 2 } }, // 0
  { ac: 16, hp: 22, perception: 7, attack: 9, damage: { dice: 1, faces: 8, bonus: 3 } }, // 1
  { ac: 18, hp: 30, perception: 8, attack: 11, damage: { dice: 1, faces: 10, bonus: 5 } }, // 2
  { ac: 19, hp: 40, perception: 10, attack: 12, damage: { dice: 2, faces: 6, bonus: 5 } }, // 3
  { ac: 21, hp: 50, perception: 11, attack: 14, damage: { dice: 2, faces: 6, bonus: 7 } }, // 4
  { ac: 22, hp: 60, perception: 13, attack: 15, damage: { dice: 2, faces: 8, bonus: 7 } }, // 5
  { ac: 24, hp: 72, perception: 14, attack: 17, damage: { dice: 2, faces: 8, bonus: 9 } }, // 6
  { ac: 25, hp: 85, perception: 16, attack: 18, damage: { dice: 2, faces: 10, bonus: 9 } }, // 7
  { ac: 27, hp: 99, perception: 17, attack: 20, damage: { dice: 3, faces: 8, bonus: 9 } }, // 8
  { ac: 28, hp: 115, perception: 19, attack: 21, damage: { dice: 3, faces: 8, bonus: 11 } }, // 9
  { ac: 30, hp: 130, perception: 20, attack: 23, damage: { dice: 3, faces: 10, bonus: 11 } }, // 10
  { ac: 31, hp: 145, perception: 22, attack: 24, damage: { dice: 3, faces: 10, bonus: 13 } }, // 11
  { ac: 33, hp: 160, perception: 23, attack: 26, damage: { dice: 4, faces: 8, bonus: 13 } }, // 12
];

export function benchmark(level: number): Benchmark {
  const idx = Math.max(0, Math.min(BENCHMARKS.length - 1, level + 1));
  return BENCHMARKS[idx]!;
}

/**
 * GM Core encounter building, as DATA. The RAW tables assume a party of 4;
 * the engine computes the budget for the REAL party (today: a solo player,
 * where a single on-level creature is already an EXTREME encounter) and
 * trims whatever the model declares beyond it.
 */
export type EncounterDifficulty = "trivial" | "low" | "moderate" | "severe" | "extreme";

export const ENCOUNTER_DIFFICULTIES: readonly EncounterDifficulty[] = [
  "trivial",
  "low",
  "moderate",
  "severe",
  "extreme",
];

// XP of one creature by (creature level - party level), delta -4 .. +4.
const CREATURE_XP_BY_DELTA = [10, 15, 20, 30, 40, 60, 80, 120, 160];

/**
 * XP cost of a creature vs the party level. Below PL-4 → 0 (doesn't count);
 * above PL+4 → null (forbidden at ANY difficulty — never enters play).
 */
export function creatureXp(creatureLevel: number, partyLevel: number): number | null {
  const delta = creatureLevel - partyLevel;
  if (delta < -4) return 0;
  if (delta > 4) return null;
  return CREATURE_XP_BY_DELTA[delta + 4]!;
}

// { base budget for a party of 4, adjustment per character more/fewer }.
const ENCOUNTER_BUDGETS: Record<EncounterDifficulty, { base: number; adjust: number }> = {
  trivial: { base: 40, adjust: 10 },
  low: { base: 60, adjust: 15 },
  moderate: { base: 80, adjust: 20 },
  severe: { base: 120, adjust: 30 },
  extreme: { base: 160, adjust: 40 },
};

/** XP budget for a difficulty and party size (party of 1 ⇒ trivial 10 .. extreme 40). */
export function encounterBudget(difficulty: EncounterDifficulty, partySize: number): number {
  const { base, adjust } = ENCOUNTER_BUDGETS[difficulty];
  return Math.max(adjust, base + (partySize - 4) * adjust);
}

/** Lowest difficulty whose budget covers `totalXp` ("extreme" when none does) — audit label. */
export function classifyEncounter(totalXp: number, partySize: number): EncounterDifficulty {
  for (const d of ENCOUNTER_DIFFICULTIES) {
    if (totalXp <= encounterBudget(d, partySize)) return d;
  }
  return "extreme";
}

/** Party size is COMPUTED (player + allies), never assumed — solo today, maybe not later. */
export function partySizeOf(combatants: Combatant[]): number {
  return Math.max(
    1,
    combatants.filter((c) => c.kind === "player" || c.kind === "ally").length,
  );
}

export interface EnemySpec {
  name: string;
  level: number;
  count: number;
}

export interface EncounterPlan {
  accepted: EnemySpec[];
  /** Above party level +4 — forbidden at any difficulty. */
  droppedForbidden: EnemySpec[];
  /** Legal creatures that didn't fit the XP budget. */
  trimmedOver: EnemySpec[];
  /** Set when the anti-empty rule replaced the only creature with a weaker one. */
  downleveled?: { name: string; from: number; to: number };
  totalXp: number;
  budget: number;
  requested: EncounterDifficulty;
  classified: EncounterDifficulty;
  /** True when everything the model declared entered play as declared. */
  fits: boolean;
}

/**
 * Fits the declared enemies into the XP budget, creature by creature in the
 * order given. `existingXp` is 0 for a new combat, or the XP already on the
 * field for reinforcements (defeated enemies INCLUDED — one encounter, one
 * budget; that is what blocks the model from spawning endless waves).
 */
export function planEncounter(
  specs: EnemySpec[],
  existingXp: number,
  opts: { partyLevel: number; partySize: number; difficulty: EncounterDifficulty },
): EncounterPlan {
  const budget = encounterBudget(opts.difficulty, opts.partySize);
  const accepted: EnemySpec[] = [];
  const droppedForbidden: EnemySpec[] = [];
  const trimmedOver: EnemySpec[] = [];
  let totalXp = existingXp;

  for (const spec of specs) {
    const xp = creatureXp(spec.level, opts.partyLevel);
    if (xp === null) {
      droppedForbidden.push({ ...spec });
      continue;
    }
    let fit = 0;
    for (let i = 0; i < spec.count; i++) {
      if (totalXp + xp <= budget) {
        totalXp += xp;
        fit++;
      }
    }
    if (fit > 0) accepted.push({ ...spec, count: fit });
    if (fit < spec.count) trimmedOver.push({ ...spec, count: spec.count - fit });
  }

  // A narratively declared NEW combat must never start empty: down-level the
  // first creature to the strongest level whose XP still fits the budget.
  let downleveled: EncounterPlan["downleveled"];
  if (accepted.length === 0 && existingXp === 0 && specs.length > 0) {
    const first = specs[0]!;
    let level = opts.partyLevel + 4;
    while ((creatureXp(level, opts.partyLevel) ?? Infinity) > budget) level--;
    downleveled = { name: first.name, from: first.level, to: level };
    accepted.push({ name: first.name, level, count: 1 });
    totalXp += creatureXp(level, opts.partyLevel)!;
    // The replaced creature is no longer "cut" — drop one from its list.
    const cutList = droppedForbidden[0]?.name === first.name ? droppedForbidden : trimmedOver;
    if (cutList[0] && --cutList[0].count <= 0) cutList.shift();
  }

  return {
    accepted,
    droppedForbidden,
    trimmedOver,
    downleveled,
    totalXp,
    budget,
    requested: opts.difficulty,
    classified: classifyEncounter(totalXp, opts.partySize),
    fits: droppedForbidden.length === 0 && trimmedOver.length === 0 && !downleveled,
  };
}

/** MAP for the next Strike: 0 → -0, 1 → -5/-4 (agile), 2+ → -10/-8 (agile). */
export function mapPenalty(progress: number, agile = false): number {
  if (progress <= 0) return 0;
  if (progress === 1) return agile ? -4 : -5;
  return agile ? -8 : -10;
}

function newCombatant(partial: Partial<Combatant> & Pick<Combatant, "name" | "kind">): Combatant {
  return {
    id: randomUUID().slice(0, 8),
    initiative: 0,
    ac: 10,
    maxHp: 1,
    currentHp: 1,
    conditions: [],
    actionsRemaining: 0,
    reactionAvailable: true,
    mapProgress: 0,
    level: null,
    traits: [],
    defeated: false,
    ...partial,
  };
}

/**
 * Fonte dos modificadores que a FICHA aplica, lida do dado (Fase 2.5 / T5.4).
 *
 * Injetada pelo mesmo motivo de `ConditionModifierSource`: `combat.ts` é puro e
 * nunca carrega o dataset. Sem registro (teste unitário sem `generated/`), a
 * ficha simplesmente não contribui — e é o comportamento honesto, porque a
 * alternativa seria uma tabela escrita à mão fingindo cobrir 7.039 feats.
 *
 * Foi o que substituiu `PASSIVE_FEAT_EFFECTS`, que tinha UMA entrada
 * ("incredible initiative": +2 iniciativa) — hoje esse mesmo +2 vem do
 * `FlatModifier` do próprio feat no dataset.
 */
export type ActorModifierSource = (
  character: Character,
  selector: string | string[],
) => Modifier[];

let actorSource: ActorModifierSource | null = null;

export function setActorModifierSource(fn: ActorModifierSource | null): void {
  actorSource = fn;
}

/**
 * Fonte das DEFESAS tipadas que a ficha concede (T5.5): `Resistance`,
 * `Weakness` e `Immunity` do dado. Mesma injeção, mesmo motivo.
 */
export type ActorDefenseSource = (character: Character) => Defenses;

let defenseSource: ActorDefenseSource | null = null;

export function setActorDefenseSource(fn: ActorDefenseSource | null): void {
  defenseSource = fn;
}

/** Os modificadores da ficha sobre um seletor, empilhados pela regra do PF2e. */
export function sheetStack(
  character: Character,
  selector: string | string[],
): ModifierStack {
  return new ModifierStack().addAll(actorSource ? actorSource(character, selector) : []);
}

/** Builds the player's combatant from the sheet + current HP. */
/**
 * Recorta as defesas tipadas de um statblock. Campo vazio fica AUSENTE (mesmo
 * padrão do importador) — save menor e `undefined` já significa "sem defesa".
 */
function statblockDefenses(sb: CreatureStatblock): Defenses {
  return {
    ...(sb.immunities?.length ? { immunities: sb.immunities } : {}),
    ...(sb.weaknesses?.length ? { weaknesses: sb.weaknesses } : {}),
    ...(sb.resistances?.length ? { resistances: sb.resistances } : {}),
  };
}

export function playerCombatant(character: Character, currentHp: number): Combatant {
  // Iniciativa é COMPOSTA pela engine (d20 + percepção), não vem pronta da
  // ficha — por isso é um dos seletores em que o modificador incondicional do
  // dado se aplica sem risco de dupla contagem.
  const passive = sheetStack(character, "initiative").total();
  // Duas fontes de defesa, e nenhuma cobre a outra: o Pathbuilder manda
  // resistências como texto livre (`character.resistances`) e não exporta
  // imunidade nem fraqueza; o dado tem as três, vindas de feats/herança/deidade.
  // O que não tiver valor numérico fica de fora, nunca vira 0 silencioso.
  const merged = playerDefenses(character);
  return newCombatant({
    name: character.name,
    kind: "player",
    initiative: d20() + character.perception + passive,
    ac: character.ac,
    maxHp: character.maxHp,
    currentHp,
    level: character.level,
    ...merged,
  });
}

/**
 * As defesas tipadas do jogador: ficha + dado + o que os efeitos ATIVOS dão.
 *
 * É recomposta do zero, nunca acumulada, porque efeito expira: somar resistência
 * na entrada e esquecer de tirar na saída deixaria o personagem imune a frio
 * três cenas depois de a magia acabar.
 */
export function playerDefenses(character: Character, fromEffects: Defenses = {}): Defenses {
  const { resistances } = parsePlayerResistances(character.resistances);
  const fromData = defenseSource ? defenseSource(character) : {};
  return mergeDefenses(
    mergeDefenses({ ...(resistances.length ? { resistances } : {}) }, fromData),
    fromEffects,
  );
}

/** Une duas listas de defesa; do mesmo tipo vale a MAIOR (RAW: não somam). */
function mergeDefenses(a: Defenses, b: Defenses): Defenses {
  const immunities = [...new Set([...(a.immunities ?? []), ...(b.immunities ?? [])])];
  const pick = (
    xs: { type: string; value: number }[] = [],
    ys: { type: string; value: number }[] = [],
  ): { type: string; value: number }[] => {
    const out: { type: string; value: number }[] = [];
    for (const d of [...xs, ...ys]) {
      const cur = out.find((o) => o.type === d.type);
      if (!cur) out.push({ ...d });
      else if (d.value > cur.value) cur.value = d.value;
    }
    return out;
  };
  const weaknesses = pick(a.weaknesses, b.weaknesses);
  const resistances = pick(a.resistances, b.resistances);
  return {
    ...(immunities.length ? { immunities } : {}),
    ...(weaknesses.length ? { weaknesses } : {}),
    ...(resistances.length ? { resistances } : {}),
  };
}

/**
 * Builds an enemy combatant. With a real statblock (bestiary) uses its
 * AC/HP/perception/saves; without, falls back to the level benchmark.
 */
export function enemyCombatant(
  name: string,
  level: number,
  sb?: CreatureStatblock & { sourceName: string; traits: string[] },
): Combatant {
  // Statblock sem HP utilizável não é statblock: entrar com hp 0 faria a
  // criatura nascer DERROTADA. Cai no benchmark de nível — o mesmo caminho
  // honesto de quem não tem statblock (achado da varredura: Phantasmal
  // Protagonist, nível 4, hp 0 no dataset).
  if (sb && !(sb.hp > 0)) sb = undefined;
  if (sb) {
    return newCombatant({
      name,
      kind: "enemy",
      initiative: d20() + sb.perception,
      ac: sb.ac,
      maxHp: sb.hp,
      currentHp: sb.hp,
      level,
      traits: sb.traits,
      sourceName: sb.sourceName,
      saves: sb.saves,
      ...statblockDefenses(sb),
    });
  }
  const b = benchmark(level);
  return newCombatant({
    name,
    kind: "enemy",
    initiative: d20() + b.perception,
    ac: b.ac,
    maxHp: b.hp,
    currentHp: b.hp,
    level,
  });
}

/** Teto de party do ADR-004: jogador + até 3 companheiros. */
export const MAX_PARTY_SIZE = 4;

/**
 * Reações DEFENSIVAS do jogador que a engine dispara contra um Strike inimigo
 * (ver `playerReactionVsStrike` em agent.ts).
 *
 * Mora AQUI, no módulo puro, porque o JUIZ da bateria também precisa dela: ele
 * tem de saber quanto de CA a reação daria para decidir se deixar de usá-la foi
 * erro ou economia. Quando cada lado tinha sua própria ideia disso, a engine
 * guardava a reação num golpe que já erraria (correto) e o juiz acusava o jogo
 * de não honrar o feat (gate de 26/07). Uma fonte, os dois concordam por
 * construção.
 *
 * Só entram reações cujo gatilho a engine SABE produzir ("uma criatura te
 * ataca"). Reações de movimento dependem de posição — Fase 3.
 */
export const PLAYER_STRIKE_REACTIONS: Record<
  string,
  { acBonus: number; meleeOnly?: boolean; needsShield?: boolean }
> = {
  // Trigger: "A creature targets you with an attack and you can see the attacker."
  "nimble dodge": { acBonus: 2 },
  // Trigger: "A creature you can see targets you with an attack." (panache não
  // é modelado; o feat na ficha é o gate.)
  "flashy dodge": { acBonus: 2 },
  // Trigger: "An enemy hits you with a melee Strike." Raise a Shield na hora.
  "reactive shield": { acBonus: 2, meleeOnly: true, needsShield: true },
};

/**
 * Builds a Companion at recruit time. With a real statblock (bestiary NPC)
 * uses its AC/HP/perception/saves; without, the level benchmark — the same
 * two honest paths an enemy gets. Stats are resolved ONCE and stored on the
 * companion so they never drift under a dataset change.
 */
export function newCompanion(
  name: string,
  level: number,
  persona: string,
  sb?: CreatureStatblock & { sourceName: string; traits: string[] },
): Companion {
  // Mesmo guard do inimigo: statblock sem HP utilizável cai no benchmark.
  if (sb && !(sb.hp > 0)) sb = undefined;
  if (sb) {
    return {
      id: randomUUID().slice(0, 8),
      name,
      level,
      ac: sb.ac,
      maxHp: sb.hp,
      currentHp: sb.hp,
      perception: sb.perception,
      conditions: [],
      traits: sb.traits,
      persona,
      sourceName: sb.sourceName,
      saves: sb.saves,
      ...statblockDefenses(sb),
    };
  }
  const b = benchmark(level);
  return {
    id: randomUUID().slice(0, 8),
    name,
    level,
    ac: b.ac,
    maxHp: b.hp,
    currentHp: b.hp,
    perception: b.perception,
    conditions: [],
    traits: [],
    persona,
  };
}

/**
 * Builds the ally combatant for a companion entering combat. HP and conditions
 * carry over from the roster (a wounded companion enters wounded); a companion
 * at 0 HP enters DEFEATED — the roster never lies to the fight.
 */
export function allyCombatant(comp: Companion): Combatant {
  const hp = Math.max(0, Math.min(comp.currentHp, comp.maxHp));
  return newCombatant({
    id: comp.id,
    name: comp.name,
    kind: "ally",
    initiative: d20() + comp.perception,
    ac: comp.ac,
    maxHp: comp.maxHp,
    currentHp: hp,
    conditions: [...comp.conditions],
    level: comp.level,
    traits: [...comp.traits],
    sourceName: comp.sourceName,
    saves: comp.saves,
    ...(comp.immunities?.length ? { immunities: comp.immunities } : {}),
    ...(comp.weaknesses?.length ? { weaknesses: comp.weaknesses } : {}),
    ...(comp.resistances?.length ? { resistances: comp.resistances } : {}),
    defeated: hp === 0,
  });
}

/**
 * The strike an enemy uses on its turn, resolved from DATA when available.
 * With a statblock: prefers the first melee attack (no rangeIncrement — the
 * engine has no positioning), else the first attack; `agile` comes from the
 * attack's traits. Without: the level benchmark (label "Strike", not agile).
 */
export interface StrikeProfile {
  label: string;
  bonus: number;
  damage: { formula: string; type: string }[];
  agile: boolean;
  /** Entradas de dano persistente do ataque (viram condição no hit). */
  persistent: { formula: string; type: string }[];
}

export function strikeProfileFrom(
  sb: CreatureStatblock | undefined,
  level: number,
): StrikeProfile {
  const attack =
    sb?.attacks.find((a) => a.rangeIncrement === undefined) ?? sb?.attacks[0];
  if (attack) {
    // Entradas category "persistent" saem do golpe direto: no hit viram a
    // condição "persistent <type> damage <formula>" (tick no fim da rodada).
    // Strike 100% persistente mantém tudo no direto para nunca golpear por 0.
    const direct = attack.damage.filter((d) => d.category !== "persistent");
    const persistent =
      direct.length > 0
        ? attack.damage.filter((d) => d.category === "persistent")
        : [];
    const rolls = direct.length > 0 ? direct : attack.damage;
    return {
      label: attack.name,
      bonus: attack.bonus,
      damage: rolls.map((d) => ({ formula: d.formula, type: d.type })),
      agile: attack.traits.includes("agile"),
      persistent: persistent.map((d) => ({
        formula: d.formula,
        // "persistent bleed" às vezes já vem no type; normaliza para só o tipo.
        type: d.type.replace(/^persistent\s+/i, "") || "bleed",
      })),
    };
  }
  const b = benchmark(level);
  return {
    label: "Strike",
    bonus: b.attack,
    damage: [
      {
        formula: `${b.damage.dice}d${b.damage.faces}+${b.damage.bonus}`,
        type: "damage",
      },
    ],
    agile: false,
    persistent: [],
  };
}

/**
 * Builds a fresh Combat from the given combatants, sorted by initiative
 * (highest first). The first combatant's turn resources are readied.
 */
export function buildCombat(combatants: Combatant[]): Combat {
  const sorted = [...combatants].sort((a, b) => b.initiative - a.initiative);
  const first = sorted[0];
  if (first) {
    first.actionsRemaining = 3;
    first.reactionAvailable = true;
    first.mapProgress = 0;
  }
  return { active: true, round: 1, turnIndex: 0, combatants: sorted };
}

/** "victory" if no enemies remain, "defeat" if no player/allies remain, else "ongoing". */
export function combatStatus(combat: Combat): "victory" | "defeat" | "ongoing" {
  const enemiesLeft = combat.combatants.some((c) => c.kind === "enemy" && !c.defeated);
  const alliesLeft = combat.combatants.some((c) => c.kind !== "enemy" && !c.defeated);
  if (!enemiesLeft) return "victory";
  if (!alliesLeft) return "defeat";
  return "ongoing";
}

/** The player's combatant in this combat (if present). */
export function playerOf(combat: Combat): Combatant | undefined {
  return combat.combatants.find((c) => c.kind === "player");
}

/** A living enemy to act as the attacker on an enemy Strike (prefers the active one). */
export function livingEnemy(combat: Combat): Combatant | undefined {
  const alive = combat.combatants.filter((c) => c.kind === "enemy" && !c.defeated);
  const active = activeCombatant(combat);
  if (active && alive.includes(active)) return active;
  return alive[0];
}

/**
 * Readies the player's turn: refills everyone's actions, clears MAP. In this
 * solo game each player message IS the player's turn, so we reset per message
 * (the player expects a fresh 3 actions each time). The round counter advances
 * separately, once a full round completes (see the enemy-turn resolver).
 */
export function beginPlayerRound(combat: Combat): void {
  for (const c of combat.combatants) {
    c.mapProgress = 0;
    c.reactionAvailable = true;
    if (!c.defeated) c.actionsRemaining = 3;
  }
}

/** Value of a "name N" condition inside a plain string[] ("dying 2" → 2). */
export function conditionValueIn(conditions: string[], name: string): number {
  for (const cond of conditions) {
    const m = cond.toLowerCase().match(new RegExp(`^${name}\\s*(\\d+)?$`));
    if (m) return m[1] ? Number(m[1]) : 1;
  }
  return 0;
}

/** Replaces/sets a valued condition in a string[]; value <= 0 removes it. */
export function setValuedCondition(conditions: string[], name: string, value: number): string[] {
  const rest = conditions.filter(
    (c) => !c.toLowerCase().match(new RegExp(`^${name}\\s*(\\d+)?$`)),
  );
  if (value <= 0) return rest;
  return [...rest, `${name} ${value}`];
}

/**
 * PF2e recovery check (flat check DC 10 + dying, with nat 20/1 bumps):
 * crit success −2 dying, success −1, failure +1, crit failure +2.
 */
export function applyRecovery(
  die: number,
  dying: number,
): { degree: DegreeOfSuccess; newDying: number } {
  const degree = degreeOfSuccess(die, die, 10 + dying);
  const delta =
    degree === "criticalSuccess" ? -2 : degree === "success" ? -1 : degree === "failure" ? 1 : 2;
  return { degree, newDying: Math.max(0, dying + delta) };
}

/**
 * Sanitizes a tool-provided action cost: 1..3, integer, `fallback` when absent
 * or invalid. Activities cost their FULL value on the resolving roll; the
 * fallback is 1 (a plain Strike/skill action) or 0 (a free reactive save).
 */
export function clampActionCost(v: unknown, fallback = 1): number {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(3, Math.max(fallback === 0 ? 0 : 1, Math.round(n)));
}

/**
 * Normalizes a name for fuzzy matching: lowercase, no parenthetical, no
 * punctuation (a model's broken JSON escaping produces variants like
 * `Scavenger\" (Thug)` vs `Scavenger" (Thug)` that must match), collapsed
 * spaces. Digits are kept — "Thug 1" and "Thug 2" are different combatants.
 */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\([^)]*\)/g, "")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * True if the combat already has a combatant whose name fuzzily matches `name`.
 * Used to stop `start_combat` from spawning a phantom duplicate when the model
 * renames a foe slightly (e.g. "Gate Administrator" vs "Gate Administrator (Human)").
 */
export function hasCombatantNamed(combat: Combat, name: string): boolean {
  const key = normalizeName(name);
  if (!key) return false;
  return combat.combatants.some((c) => {
    const n = normalizeName(c.name);
    return n.length > 0 && (n === key || n.includes(key) || key.includes(n));
  });
}

/** Finds a combatant by id, "[id:…]" tag, or (case-insensitive, fuzzy) name. */
export function findCombatant(combat: Combat, ref: string): Combatant | undefined {
  // The combat state block lists combatants as "Name [id:xxx]" and the model
  // often echoes that whole string back as the target — honor the id tag first.
  const taggedId = ref.match(/\[id:\s*([^\]]+)\]/i)?.[1]?.trim();
  if (taggedId) {
    const byId = combat.combatants.find((c) => c.id === taggedId);
    if (byId) return byId;
  }
  const cleaned = ref.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();
  const key = cleaned.toLowerCase();
  // Chave VAZIA não casa ninguém. `"goblin".includes("")` é true, então uma
  // tag de id obsoleta ou alucinada (`"[id:4f2a]"` de um combate anterior —
  // ids são regerados a cada `buildCombat`) devolvia o combatente de MAIOR
  // INICIATIVA como se tivesse sido nomeado. Em `roll_check` o atacante é
  // derivado do alvo, então isso chegava a virar o inimigo batendo no jogador.
  if (!key) return undefined;
  const exact =
    combat.combatants.find((c) => c.id === ref.trim()) ??
    combat.combatants.find((c) => c.name.toLowerCase() === key) ??
    combat.combatants.find((c) => c.name.toLowerCase().includes(key));
  if (exact) return exact;
  // Fuzzy fallback in BOTH directions ("Vexcia (Administrator), the clerk"
  // must still find "Vexcia (Administrator)").
  const norm = normalizeName(cleaned);
  if (!norm) return undefined;
  return combat.combatants.find((c) => {
    const n = normalizeName(c.name);
    return n.length > 0 && (n === norm || n.includes(norm) || norm.includes(n));
  });
}

/** The combatant whose turn it currently is. */
export function activeCombatant(combat: Combat): Combatant | undefined {
  return combat.combatants[combat.turnIndex];
}

/** Value of a "name N" condition ("frightened 2" → 2; plain "name" → 1; absent → 0). */
export function conditionValue(c: Combatant, name: string): number {
  for (const cond of c.conditions) {
    const m = cond.toLowerCase().match(new RegExp(`^${name}\\s*(\\d+)?$`));
    if (m) return m[1] ? Number(m[1]) : 1;
  }
  return 0;
}

/** True if the combatant is off-guard (a.k.a. flat-footed). */
export function isOffGuard(c: Combatant): boolean {
  return c.conditions.some((cond) => /off-guard|flat-footed/i.test(cond));
}

/**
 * Fonte dos modificadores de condição. Fica INJETADA porque `combat.ts` é puro
 * (nunca carrega o dataset em runtime) e a fonte oficial vive no dado. Sem
 * registro — em teste unitário, por exemplo — vale o fallback embutido abaixo,
 * que é o comportamento histórico da engine.
 *
 * Um ponto de injeção só, e não um parâmetro em cada chamada: com 10 call sites
 * de `effectiveAC`/`attackStatusPenalty`, parâmetro é convite a um deles
 * esquecer e a engine divergir de si mesma.
 */
export type ConditionModifierSource = (
  conditions: string[],
  selector: "ac" | "attack-roll",
  ro?: RollOptions,
) => Modifier[];

let conditionSource: ConditionModifierSource | null = null;

export function setConditionModifierSource(fn: ConditionModifierSource | null): void {
  conditionSource = fn;
}

/**
 * Fallback embutido: off-guard (circunstância −2 na CA) e frightened (status −N
 * em tudo). É o que a engine sempre aplicou à mão — mantido para que o núcleo
 * puro funcione sem dataset.
 */
function builtinConditionModifiers(
  conditions: string[],
  selector: "ac" | "attack-roll",
): Modifier[] {
  const mods: Modifier[] = [];
  if (selector === "ac" && conditions.some((c) => /off-guard|flat-footed/i.test(c))) {
    mods.push({ slug: "off-guard", type: "circumstance", value: -2 });
  }
  const frightened = valueOfCondition(conditions, "frightened");
  if (frightened > 0) {
    mods.push({ slug: "frightened", type: "status", value: -frightened });
  }
  return mods;
}

/** Valor de uma condição numa lista crua ("frightened 2" → 2). */
function valueOfCondition(conditions: string[], name: string): number {
  for (const cond of conditions) {
    const m = cond.toLowerCase().match(new RegExp(`^${name}\\s*(\\d+)?$`));
    if (m) return m[1] ? Number(m[1]) : 1;
  }
  return 0;
}

/**
 * A pilha de modificadores de condição que incide sobre um seletor.
 *
 * `ro` é o contexto da rolagem DO PONTO DE VISTA de `c`: em PF2e o rule element
 * mora no ator, e `self:` dentro do predicado é sempre o dono da condição. Por
 * isso a CA do defensor e a rolagem do atacante pedem contextos diferentes —
 * ver `rollOptionsOf` em `agent.ts`. Sem `ro`, condição com predicado não
 * aplica (indecidível não é permissão).
 */
export function conditionStack(
  c: Combatant,
  selector: "ac" | "attack-roll",
  ro?: RollOptions,
): ModifierStack {
  const source = conditionSource ?? builtinConditionModifiers;
  return new ModifierStack().addAll(source(c.conditions, selector, ro));
}

/**
 * Effective AC for a Strike against `target`. Os modificadores das condições
 * empilham por tipo (PF2e): off-guard é circunstância e frightened é status,
 * então somam entre si — mas dois status não somam entre eles.
 */
export function effectiveAC(
  target: Combatant,
  ro?: RollOptions,
  extra: readonly Modifier[] = [],
): number {
  // `extra` são os modificadores de CA do próprio defensor vindos da ficha e
  // dos efeitos ativos (Fase 2.6). Chegam de fora porque só `agent.ts` conhece a
  // sessão; o núcleo segue puro e, sem eles, se comporta como antes.
  return target.ac + conditionStack(target, "ac", ro).addAll(extra).total();
}

/** Penalidade das condições do atacante sobre a rolagem de ataque. */
export function attackStatusPenalty(attacker: Combatant, ro?: RollOptions): number {
  return conditionStack(attacker, "attack-roll", ro).total();
}

/**
 * End-of-round condition upkeep, run once after the enemies' turns resolve:
 * - off-guard/flat-footed expires (it's circumstantial — e.g. Twin Feint's
 *   off-guard only applies to a Strike within the turn, not forever);
 * - valued conditions decrement by 1 (frightened 2 → frightened 1 → gone),
 *   per PF2e's end-of-turn recovery for frightened.
 * Plain conditions without a value (prone, grabbed…) are left alone.
 */
export function tickEndOfRound(combat: Combat): void {
  for (const c of combat.combatants) {
    c.conditions = c.conditions
      .filter((cond) => !/^(off-guard|flat-footed)$/i.test(cond.trim()))
      .map((cond) => {
        // Famílias com regra própria NÃO entram no decremento genérico:
        // "persistent fire damage 2" termina por flat check (tickPersistentDamage),
        // não por contagem; dying/wounded mudam por recovery check/cura.
        if (/^(persistent|dying|wounded)\b/i.test(cond.trim())) return cond;
        const m = cond.match(/^(.*\S)\s+(\d+)$/);
        if (!m) return cond;
        const value = Number(m[2]) - 1;
        return value <= 0 ? "" : `${m[1]} ${value}`;
      })
      .filter(Boolean);
  }
}

/**
 * Dano persistente (RAW): no fim do turno do afetado, sofre o dano e então um
 * flat check DC 15 encerra a condição. Neste engine ("1 mensagem = 1 rodada")
 * o tick roda uma vez por rodada, após os turnos inimigos. Aceita valor flat
 * ("persistent fire damage 4") e fórmula ("persistent bleed damage 1d4+1").
 */
export interface PersistentTick {
  combatant: Combatant;
  type: string;
  amount: number;
  before: number;
  after: number;
  flatRoll: number;
  /** true quando o flat check (DC 15) encerrou a condição. */
  ended: boolean;
  /** Ajuste por imunidade/fraqueza/resistência (`""` quando não houve). */
  note: string;
}

const PERSISTENT_RE = /^persistent\s+(.+?)\s+damage(?:\s+(\d+(?:d\d+)?(?:[+-]\d+)?))?$/i;

/** Rola um valor "3", "1d6" ou "2d4+1"; sem valor declarado usa 1d6 (RAW default ausente → mínimo honesto seria 0, mas condição sem valor é bug de escrita — 1d6 é o padrão de bomba). */
function rollPersistentAmount(spec: string | undefined): number {
  if (!spec) return rollDice(1, 6);
  if (/^\d+$/.test(spec)) return Number(spec);
  const m = /^(\d+)d(\d+)([+-]\d+)?$/i.exec(spec);
  if (!m) return 0;
  return Math.max(0, rollDice(Number(m[1]), Number(m[2])) + Number(m[3] ?? 0));
}

export function tickPersistentDamage(combat: Combat): PersistentTick[] {
  const out: PersistentTick[] = [];
  for (const c of combat.combatants) {
    if (c.defeated) continue;
    for (const cond of [...c.conditions]) {
      const m = PERSISTENT_RE.exec(cond.trim());
      if (!m) continue;
      const amount = rollPersistentAmount(m[2]);
      const before = c.currentHp;
      // O tipo já está na condição ("persistent fire damage 1d6") — dano
      // persistente também respeita imunidade/resistência.
      const adj = applyDamage(c, [{ amount, type: m[1]! }]);
      const flatRoll = d20();
      const ended = flatRoll >= 15;
      if (ended || c.defeated) {
        c.conditions = c.conditions.filter((x) => x !== cond);
      }
      out.push({
        combatant: c,
        type: m[1]!.toLowerCase(),
        amount,
        before,
        after: c.currentHp,
        flatRoll,
        ended,
        note: adj.note,
      });
    }
  }
  return out;
}

/** As defesas tipadas de um combatente, no formato que `adjustDamage` espera. */
export function defensesOf(target: Combatant): Defenses {
  return {
    immunities: target.immunities,
    weaknesses: target.weaknesses,
    resistances: target.resistances,
  };
}

/**
 * Applies damage to a combatant, clamping HP and flagging defeat.
 *
 * Aceita um número (dano SEM tipo — `update_state`, testes) ou as parcelas
 * tipadas da instância, e nesse caso passa por imunidade/fraqueza/resistência.
 * Devolve o ajuste para que o resumo mecânico mostre POR QUE o HP caiu o que
 * caiu — dano tipado que some sem explicação é estado mentindo.
 */
export function applyDamage(
  target: Combatant,
  damage: number | DamageParcel[],
): DamageAdjustment {
  const parcels: DamageParcel[] =
    typeof damage === "number" ? [{ amount: damage, type: UNTYPED }] : damage;
  const adj = adjustDamage(parcels, defensesOf(target));
  target.currentHp = Math.max(0, target.currentHp - adj.applied);
  if (target.currentHp === 0) target.defeated = true;
  return adj;
}

/**
 * Advances to the next non-defeated combatant in initiative order, resetting
 * their per-turn resources. Increments the round when wrapping past the top.
 */
export function advanceTurn(combat: Combat): void {
  const n = combat.combatants.length;
  if (n === 0) return;
  for (let step = 1; step <= n; step++) {
    const next = (combat.turnIndex + step) % n;
    const c = combat.combatants[next]!;
    if (c.defeated) continue;
    // Landing on an index that didn't move forward means we wrapped → new round.
    if (next <= combat.turnIndex) combat.round += 1;
    combat.turnIndex = next;
    c.actionsRemaining = 3;
    c.reactionAvailable = true;
    c.mapProgress = 0;
    return;
  }
}
