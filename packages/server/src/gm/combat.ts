import { randomUUID } from "node:crypto";
import type { Character, Combat, Combatant, DegreeOfSuccess } from "@pf2e/shared";
import { degreeOfSuccess } from "../dice/check.js";

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
 * Passivos de feats que a ENGINE aplica (regras-como-dados): o modelo nunca
 * lembrava deles. Tabela pequena e explícita — cresce conforme a auditoria
 * apontar. (Toughness NÃO entra: o Pathbuilder já soma o HP no export.)
 */
const PASSIVE_FEAT_EFFECTS: Record<string, { initiative?: number }> = {
  "incredible initiative": { initiative: 2 },
};

/** Soma dos bônus passivos de um tipo dado pelos feats da ficha. */
export function passiveFeatBonus(
  character: Character,
  kind: "initiative",
): { total: number; sources: string[] } {
  let total = 0;
  const sources: string[] = [];
  for (const feat of character.feats) {
    const effect = PASSIVE_FEAT_EFFECTS[feat.toLowerCase().trim()];
    const value = effect?.[kind];
    if (value) {
      total += value;
      sources.push(feat);
    }
  }
  return { total, sources };
}

/** Builds the player's combatant from the sheet + current HP. */
export function playerCombatant(character: Character, currentHp: number): Combatant {
  const passive = passiveFeatBonus(character, "initiative");
  return newCombatant({
    name: character.name,
    kind: "player",
    initiative: d20() + character.perception + passive.total,
    ac: character.ac,
    maxHp: character.maxHp,
    currentHp,
    level: character.level,
  });
}

/** Builds an enemy combatant from benchmark stats for its level. */
export function enemyCombatant(name: string, level: number): Combatant {
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
 * Effective AC for a Strike against `target`: base AC −2 if off-guard
 * (circumstance) − the target's own frightened value (status penalty to DCs/AC).
 */
export function effectiveAC(target: Combatant): number {
  let ac = target.ac;
  if (isOffGuard(target)) ac -= 2;
  ac -= conditionValue(target, "frightened");
  return ac;
}

/** Status penalty to the attacker's Strike rolls (−frightened). */
export function attackStatusPenalty(attacker: Combatant): number {
  const v = conditionValue(attacker, "frightened");
  return v === 0 ? 0 : -v; // avoid JS -0 from negating zero
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
        const m = cond.match(/^(.*\S)\s+(\d+)$/);
        if (!m) return cond;
        const value = Number(m[2]) - 1;
        return value <= 0 ? "" : `${m[1]} ${value}`;
      })
      .filter(Boolean);
  }
}

/** Applies damage (>=0) to a combatant, clamping HP and flagging defeat. */
export function applyDamage(target: Combatant, amount: number): void {
  target.currentHp = Math.max(0, target.currentHp - Math.max(0, amount));
  if (target.currentHp === 0) target.defeated = true;
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
