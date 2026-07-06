import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { AttackContext, Character, Combatant, Weapon } from "@pf2e/shared";
import type { CheckResult, GameState } from "@pf2e/shared";
import { isValidDc, rollCheck } from "../dice/check.js";
import {
  activityFrequency,
  activityRequirement,
  itemRecord,
  itemTraits,
  lookupLocalRule,
  multiActionCost,
  namedActivity,
  officialConditions,
  type RuleRecord,
} from "../rules/dataset.js";
import { lookupWebRule } from "../rules/web.js";
import {
  applyDamage,
  applyRecovery,
  attackStatusPenalty,
  beginPlayerRound,
  benchmark,
  buildCombat,
  clampActionCost,
  conditionValueIn,
  setValuedCondition,
  combatStatus,
  effectiveAC,
  enemyCombatant,
  findCombatant,
  hasCombatantNamed,
  isOffGuard,
  livingEnemy,
  mapPenalty,
  passiveFeatBonus,
  playerCombatant,
  playerOf,
  rollDice,
  tickEndOfRound,
} from "./combat.js";
import { loadLore, loadWorld } from "./lore.js";
import {
  NARRATIVE_SYSTEM_PROMPT,
  RULES_SYSTEM_PROMPT,
  characterSheetBlock,
} from "./prompts.js";
import type { Session } from "./sessions.js";

/**
 * Single model that drives both stages by default. Each stage runs its own
 * CONTEXT (system prompt + message thread), not its own model — so LM Studio
 * keeps one model resident across the turn instead of swapping weights (which
 * on ~12 GB VRAM costs minutes per turn). Gemma 4 12B (official, Q4) is the
 * default: it fits entirely in ~12 GB VRAM (no CPU offload) and follows
 * instructions well. Keep the LM Studio context modest so its KV cache fits.
 */
const GM_MODEL = process.env.GM_MODEL ?? "google/gemma-4-12b";
/** Model for the RULES/tools stage. Defaults to GM_MODEL; override only to
 * split across two models (needs enough VRAM to avoid a per-turn swap). */
export const RULES_MODEL = process.env.RULES_MODEL ?? GM_MODEL;
/** Model for the NARRATIVE stage. Defaults to GM_MODEL; override only to split
 * across two models (needs enough VRAM to avoid a per-turn swap). */
export const NARRATIVE_MODEL = process.env.NARRATIVE_MODEL ?? GM_MODEL;
/** LM Studio's OpenAI-compatible base URL (the server runs locally on :1234). */
const LMSTUDIO_BASE_URL =
  process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1";
const MAX_ITERATIONS = 8;
/**
 * Combatant ids que JÁ levaram dano de Strike da engine neste turno — usado
 * para rejeitar a dupla contagem quando o modelo tenta reaplicar o dano via
 * `update_state` (reincidiu em play-test mesmo com o prompt proibindo).
 */
const turnStruck = new WeakMap<Session, Set<string>>();
/**
 * Atividades multi-ação já cobradas neste turno (nome canônico → pago). O
 * custo CHEIO é cobrado na primeira rolagem que menciona a atividade; as
 * rolagens seguintes da MESMA atividade custam 0 (Twin Feint: 2 Strikes, 2
 * ações no total). Sem isso o modelo esquecia o custo (auditoria de feats:
 * Sudden Charge 2→1, Improvised Repair 3→0).
 */
const turnActivityCharged = new WeakMap<Session, Set<string>>();
/**
 * Frequency "once per round/turn" (dataset): usos por TURNO do jogador —
 * 1 mensagem = 1 turno completo neste engine. Resetado a cada runRulesStage.
 */
const turnFrequencyUsed = new WeakMap<Session, Map<string, number>>();
/**
 * Frequency de períodos longos (PT1H, day...): a engine só consegue julgar
 * dentro do MESMO combate (o tempo narrativo fora dele é fluido). Resetado
 * quando um combate novo começa.
 */
const combatFrequencyUsed = new WeakMap<Session, Map<string, number>>();

/** Store de frequency para um `per` do dataset (null = engine não julga). */
function frequencyStore(session: Session, per: string): Map<string, number> | null {
  const perTurn = per === "round" || per === "turn";
  const holder = perTurn ? turnFrequencyUsed : combatFrequencyUsed;
  if (!perTurn && !session.state.combat?.active) return null;
  let map = holder.get(session);
  if (!map) {
    map = new Map();
    holder.set(session, map);
  }
  return map;
}

/**
 * Peek: a atividade citada no texto estourou sua Frequency? Retorna o erro
 * educativo, ou null. O uso só é gravado por `commitFrequency` — chamado
 * DEPOIS de todas as outras validações passarem (uma rejeição de custo não
 * pode queimar o limite).
 */
export function frequencyLimit(session: Session, text: string): ToolOutcome | null {
  const freq = activityFrequency(text);
  if (!freq) return null;
  const store = frequencyStore(session, freq.per);
  if (!store) return null;
  if ((store.get(freq.name) ?? 0) >= freq.max) {
    const scope =
      freq.per === "round" || freq.per === "turn" ? "this turn" : "this fight";
    const label = `Frequency ${freq.max}/${freq.per}`;
    return {
      content: `ILLEGAL: "${titleCase(freq.name)}" was already used ${scope} (${label}). It does NOT happen — do something else or end the turn.`,
      isError: true,
      summaryLine: `- ${titleCase(freq.name)}: NOT used — ${label} already spent ${scope}.`,
    };
  }
  return null;
}

/**
 * Requirements de atividade (validação LEVE): só padrões que a ficha responde
 * de graça — duas armas empunhadas, escudo. O resto passa sem julgamento
 * (empunhadura/postura são estado que a engine não rastreia).
 */
export function requirementBlocked(session: Session, text: string): ToolOutcome | null {
  const found = activityRequirement(text);
  if (!found) return null;
  const req = found.requirement.toLowerCase();
  const c = session.character;
  let missing = "";
  if (/wielding two (melee )?weapons|two weapons, (one|each) in (a different|each) hand/.test(req)) {
    if (c.weapons.length < 2) {
      missing = `two wielded weapons (the sheet lists ${c.weapons.length ? `only "${c.weapons.map((w) => w.name).join('", "')}"` : "none"})`;
    }
  } else if (/wielding a shield|shield is raised|have a shield raised/.test(req)) {
    const hasShield =
      c.armor.some((a) => /shield/i.test(a.name)) ||
      c.equipment.some((e) => /shield/i.test(e.name));
    if (!hasShield) missing = "a shield (none on the sheet)";
  }
  if (!missing) return null;
  const pretty = titleCase(found.name);
  return {
    content: `ILLEGAL: "${pretty}" requires ${found.requirement} — the character lacks ${missing}. It does NOT happen and no action is spent. Do something the sheet supports.`,
    isError: true,
    summaryLine: `- ${pretty}: NOT possible — requires ${found.requirement}.`,
  };
}

/**
 * Condição oficial de PF2e? Aceita a forma valuada ("frightened 2") e a
 * família "persistent X damage". Whitelist = conditions.json (44 oficiais).
 */
export function isOfficialCondition(cond: string): boolean {
  const c = cond.toLowerCase().trim();
  if (!c) return false;
  if (/^persistent\b.*damage(\s+\d+)?$/.test(c)) return true;
  const name = c.replace(/\s+\d+$/, "");
  return officialConditions().has(name);
}

/** Sugestões próximas para uma condição inválida (erro educativo). */
function conditionSuggestions(bad: string): string {
  const tokens = bad.toLowerCase().split(/[^a-z-]+/).filter((t) => t.length > 3);
  const near = [...officialConditions()].filter((n) =>
    tokens.some((t) => n.includes(t) || t.includes(n)),
  );
  return (near.length ? near : ["frightened 1", "off-guard", "prone", "grabbed"])
    .slice(0, 4)
    .join(", ");
}

/** Grava o uso de uma atividade com Frequency (par do `frequencyLimit`). */
export function commitFrequency(session: Session, text: string): void {
  const freq = activityFrequency(text);
  if (!freq) return;
  const store = frequencyStore(session, freq.per);
  store?.set(freq.name, (store.get(freq.name) ?? 0) + 1);
}

/**
 * O jogador caiu a 0 HP: entra em dying 1 (2 se foi crit) + wounded acumulado,
 * inconsciente — regras RAW de PF2e. A morte definitiva só acontece em
 * dying 4+, resolvido pelos recovery checks no início dos turnos seguintes.
 */
function enterDying(session: Session, crit: boolean): string {
  const conds = session.state.conditions;
  const wounded = conditionValueIn(conds, "wounded");
  const dying = Math.min(4, (crit ? 2 : 1) + wounded);
  let next = setValuedCondition(conds, "dying", dying);
  if (!next.some((c) => /^unconscious$/i.test(c))) next = [...next, "unconscious"];
  session.state.conditions = next;
  const combat = session.state.combat;
  const you = combat?.active ? playerOf(combat) : undefined;
  if (you) you.conditions = [...next];
  return dying >= 4
    ? `${session.character.name} drops to 0 HP and DIES instantly (dying ${dying}).`
    : `${session.character.name} drops to 0 HP: DYING ${dying}, unconscious. Recovery checks decide their fate on the following turns.`;
}
/** How many recent history messages the rules stage sees as context. */
const RULES_CONTEXT_TURNS = 6;
/** How many recent history messages the narrative stage sees (bounds context
 * growth so long sessions don't overflow the model's window). */
const NARRATIVE_CONTEXT_MESSAGES = 30;
/** LM Studio extension: disable "thinking" on reasoning models (e.g. gemma-4).
 * Without this they burn the token budget on `reasoning_content` we never show,
 * starving the visible output (empty narration). Cast because the OpenAI type
 * doesn't list "none"; LM Studio accepts it and non-reasoning models ignore it. */
const NO_REASONING = { reasoning_effort: "none" } as unknown as {
  reasoning_effort: "low";
};

/** Events emitted during a turn, forwarded to the client via SSE. */
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "check"; result: CheckResult }
  | { type: "state"; state: GameState }
  | { type: "phase"; phase: "rules" | "narrative" }
  | { type: "done" }
  | { type: "error"; message: string };

// LM Studio ignores the API key, but the OpenAI SDK requires a non-empty one.
const client = new OpenAI({ baseURL: LMSTUDIO_BASE_URL, apiKey: "lm-studio" });

/** Tool definitions in the OpenAI function-calling format. */
const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "roll_check",
      description:
        "Rolls a d20 and returns the PF2e degree of success. Use for skills, saves, Perception, and WEAPON ATTACKS (Strikes). For an attack, pass `target`: the engine uses the target's real AC, applies the Multiple Attack Penalty, and — ON A HIT — automatically rolls and applies damage (doubled on a crit, plus Sneak Attack if the target is off-guard). You do NOT need a separate damage step. Call once per Strike (a multi-Strike activity like Twin Feint = one call per Strike). NEVER state a die result without calling this tool.",
      parameters: {
        type: "object",
        properties: {
          skill: {
            type: "string",
            description:
              "What to roll: a skill (e.g. deception, stealth, athletics), a save (fortitude, reflex, will), 'perception', a Lore name, or — for an ATTACK — the weapon/Strike name (e.g. 'dagger'). For an enemy's Strike, any name works; the engine uses the enemy's attack bonus.",
          },
          dc: {
            type: "number",
            description:
              "The DC for a NON-attack check. For an attack, OMIT this — the engine uses the target's real AC from the combat state.",
          },
          target: {
            type: "string",
            description:
              "ATTACKS ONLY: the id or name of the combatant being attacked. When set (and combat is active) this is treated as a Strike by the active combatant against that target, using the target's real AC and applying MAP.",
          },
          agile: {
            type: "boolean",
            description:
              "ATTACKS ONLY: true if the weapon has the agile trait (MAP -4/-8 instead of -5/-10). For weapons on the character sheet the engine reads the trait from the rules data and IGNORES this — only pass it for weapons the sheet doesn't list (improvised, unarmed).",
          },
          actions: {
            type: "number",
            description:
              "Action cost (1-3) charged for THIS roll. Default 1. Pass the activity's FULL cost when ONE roll resolves it (Sudden Charge = 2, Vicious Swing = 2). Multi-Strike activities (Twin Feint, Double Slice) stay 1 per Strike. Pass 1 for a save that IS an action (e.g. Shake it Off); plain reactive saves cost 0 automatically.",
          },
          reason: {
            type: "string",
            description: "Short description of what is being attempted.",
          },
        },
        required: ["skill", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "spend_actions",
      description:
        "COMBAT ONLY: spends the player's actions for something that needs NO roll — activities and feats without a check (Plant Banner, Improvised Repair, raising a shield, drawing an item, a Stride without opposition). Every feat/activity with an action cost MUST be paid: if there is no roll_check to charge it, call this. The engine validates against the actions remaining.",
      parameters: {
        type: "object",
        properties: {
          actions: {
            type: "number",
            description: "How many actions to spend (1-3).",
          },
          reason: {
            type: "string",
            description: "What the actions are spent on, e.g. 'Plant Banner (1 action)'.",
          },
        },
        required: ["actions", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "use_item",
      description:
        "Uses/consumes an item from the character's Equipment (potion, elixir, bomb, torch...). The ENGINE verifies the sheet, spends the real quantity, and resolves the real effect: a bomb is thrown as a Strike with the item's REAL statblock (pass `target`); a healing potion heals its listed dice automatically. Costs 2 actions in combat (draw + use). ALWAYS use this tool for items — never spend_actions or update_state.",
      parameters: {
        type: "object",
        properties: {
          item: {
            type: "string",
            description:
              "The item's name as listed in Equipment, e.g. 'Healing Potion (Minor)' or \"Alchemist's Fire\".",
          },
          target: {
            type: "string",
            description:
              "BOMBS/offensive items only: the id or name of the combatant being targeted.",
          },
          reason: {
            type: "string",
            description: "What the character does with the item.",
          },
        },
        required: ["item", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_combat",
      description:
        "Begins a combat encounter. Call this ONCE when a fight starts. The engine adds the player, rolls initiative for everyone, and assigns real AC/HP by creature level. After this, resolve turns with roll_check (attacks), roll_damage, and end_turn.",
      parameters: {
        type: "object",
        properties: {
          enemies: {
            type: "array",
            description: "The enemies joining the fight.",
            items: {
              type: "object",
              properties: {
                name: { type: "string", description: "Creature name, e.g. 'Clockwork Sentinel'." },
                level: {
                  type: "number",
                  description:
                    "Creature level — ALWAYS estimate and pass this, it drives AC/HP/attack. Guide: mundane townsperson/clerk/merchant = -1 to 0; trained guard/thug = 1-2; veteran/soldier = 3-4; elite/leader = 5-7; boss/monster = 8+. If omitted, the engine assumes a weak commoner (level 0).",
                },
                count: { type: "number", description: "How many of this creature (default 1)." },
              },
              required: ["name"],
            },
          },
        },
        required: ["enemies"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "end_turn",
      description:
        "Ends the current combat when one side is fully defeated (victory/defeat). The player gets a fresh 3 actions each of their turns automatically, so you only need this to close out a finished fight; otherwise it's a harmless acknowledgement.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "end_combat",
      description:
        "Ends the combat encounter WITHOUT a wipe-out: enemies flee, surrender, are spared, or the player disengages and the scene moves on. (Kills close combat automatically — you don't need this for those.) NEVER leave a combat hanging once the story has moved past the fight.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description:
              "Why the fight is over, e.g. 'enemy surrendered', 'player fled the scene'.",
          },
        },
        required: ["reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_rule",
      description:
        "Looks up the official text of a PF2e rule by name: action, feat, spell, condition, item/equipment, or monster. Use before applying one of the character's abilities (e.g. 'Bon Mot', 'Sneak Attack') or a condition (e.g. 'Frightened'). Searches the local index, falling back to Archives of Nethys if not found.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look up (the rule's name)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_character",
      description:
        "Returns the player character's full sheet (attributes, skills, saves).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "update_state",
      description:
        "Records persistent state changes: damage/healing (hpDelta) and conditions gained/removed. Defaults to the player; pass `target` (a combatant id/name) during combat to affect an enemy/ally instead. Prefer roll_damage for Strike damage.",
      parameters: {
        type: "object",
        properties: {
          hpDelta: {
            type: "number",
            description: "HP change (negative = damage, positive = healing).",
          },
          addConditions: { type: "array", items: { type: "string" } },
          removeConditions: { type: "array", items: { type: "string" } },
          target: {
            type: "string",
            description:
              "Combat only: id/name of the combatant to affect (e.g. apply 'off-guard' to an enemy). Omit to affect the player.",
          },
        },
      },
    },
  },
];

/** Resolves a check's modifier from the character sheet. */
function resolveModifier(session: Session, skillRaw: string): number | null {
  const key = skillRaw.toLowerCase().trim();
  const c = session.character;
  if (key === "perception") return c.perception;
  if (key === "fortitude" || key === "fort") return c.saves.fortitude;
  if (key === "reflex" || key === "ref") return c.saves.reflex;
  if (key === "will") return c.saves.will;
  if (c.skills[key]) return c.skills[key]!.modifier;
  const lore = c.lores.find((l) => l.name.toLowerCase() === key);
  if (lore) return lore.modifier;
  const lorePartial = c.lores.find((l) => key.includes(l.name.toLowerCase()));
  if (lorePartial) return lorePartial.modifier;
  // Weapon attacks: use the weapon's precomputed attack bonus (vs target AC).
  const weapon =
    c.weapons.find((w) => w.name.toLowerCase() === key) ??
    c.weapons.find((w) => key.includes(w.name.toLowerCase()));
  if (weapon) return weapon.attack;
  if (
    (key === "attack" || key === "strike" || key === "ataque" || key === "unarmed") &&
    c.weapons[0]
  ) {
    return c.weapons[0].attack;
  }
  return null;
}

interface ToolOutcome {
  content: string;
  isError?: boolean;
  /** One player-safe line for the mechanical summary (attacks, damage, turns). */
  summaryLine?: string;
  /** Set by `end_turn`: the player passed, so enemies should retaliate now. */
  endedTurn?: boolean;
}

/** Finds the sheet weapon a roll's skill/weapon name refers to (null if none). */
export function findSheetWeapon(c: Character, ref: string): Weapon | null {
  const key = ref.toLowerCase().trim();
  if (!key) return null;
  return (
    c.weapons.find((w) => w.name.toLowerCase() === key) ??
    c.weapons.find((w) => key.includes(w.name.toLowerCase())) ??
    (key.length >= 3
      ? (c.weapons.find((w) => w.name.toLowerCase().includes(key)) ?? null)
      : null)
  );
}

/** Attack bonus for a Strike: the player's weapon bonus, or the enemy's benchmark. */
function combatAttackModifier(
  session: Session,
  attacker: Combatant,
  skill: string,
): number {
  if (attacker.kind === "player") {
    const mod = resolveModifier(session, skill);
    if (mod !== null) return mod;
    return session.character.weapons[0]?.attack ?? session.character.perception;
  }
  return benchmark(attacker.level ?? 0).attack;
}

const DAMAGE_TYPE_NAMES: Record<string, string> = {
  P: "piercing",
  S: "slashing",
  B: "bludgeoning",
};

/** Parses the faces of a die string like "d6" → 6 (defaults to 6). */
function parseDie(die: string): number {
  const m = /d(\d+)/i.exec(die);
  return m ? Number(m[1]) : 6;
}

/** Rolls a formula like "2d6+3" (single dice group + optional flat bonus). */
function rollFormula(formula: string): number {
  let total = 0;
  const dice = /(\d+)\s*d\s*(\d+)/i.exec(formula);
  if (dice) total += rollDice(Number(dice[1]), Number(dice[2]));
  const flat = /d\s*\d+\s*([+-]\s*\d+)/i.exec(formula);
  if (flat) total += Number(flat[1]!.replace(/\s+/g, ""));
  return Math.max(0, total);
}

/** Rolls Strike damage for the active attacker against a target. */
function rollDamage(
  session: Session,
  attacker: Combatant | undefined,
  input: Record<string, unknown>,
): { amount: number; type: string } {
  const crit = input.crit === true || input.degree === "criticalSuccess";
  const dbl = (n: number) => (crit ? n * 2 : n);

  const formula = input.formula ? String(input.formula) : "";
  if (formula) {
    const type = input.damageType ? String(input.damageType) : "damage";
    return { amount: dbl(rollFormula(formula)), type };
  }

  if (attacker?.kind === "player") {
    const name = String(input.weapon ?? "").toLowerCase().trim();
    const w =
      session.character.weapons.find((x) => x.name.toLowerCase() === name) ??
      session.character.weapons.find((x) => name && name.includes(x.name.toLowerCase())) ??
      session.character.weapons[0];
    if (w) {
      const amount = dbl(rollDice(1, parseDie(w.die)) + w.damageBonus);
      const type = input.damageType
        ? String(input.damageType)
        : (DAMAGE_TYPE_NAMES[w.damageType] ?? w.damageType ?? "damage");
      return { amount, type };
    }
  }

  const b = benchmark(attacker?.level ?? 0).damage;
  const type = input.damageType ? String(input.damageType) : "damage";
  return { amount: dbl(rollDice(b.dice, b.faces) + b.bonus), type };
}

/** Title-cases a weapon/skill name for the summary ("dagger" → "Dagger"). */
function titleCase(s: string): string {
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Attack bonus for throwing a bomb: DEX + weapon proficiency (bombs are
 * martial thrown weapons) + the item's own bonus. Sheets parsed before
 * weaponProficiencies existed fall back to the best weapon attack.
 */
function bombAttackBonus(c: Character, record: RuleRecord): number {
  const item = record.bonus ?? 0;
  const cat = record.weaponCategory === "simple" ? "simple" : "martial";
  const rank = c.weaponProficiencies?.[cat];
  if (rank != null) {
    const prof = rank > 0 ? c.level + rank * 2 : 0;
    return c.abilityModifiers.dex + prof + item;
  }
  return Math.max(0, ...c.weapons.map((w) => w.attack)) + item;
}

/** Number of Sneak Attack dice (d6) the character deals, or 0 if they lack it. */
function sneakAttackDice(session: Session): number {
  const c = session.character;
  const hasSneak = [...c.feats, ...c.classFeatures].some((f) => /sneak attack/i.test(f));
  if (!hasSneak) return 0;
  if (c.level >= 17) return 4;
  if (c.level >= 11) return 3;
  if (c.level >= 5) return 2;
  return 1;
}

/**
 * Level used for an enemy the model didn't level and isn't in the bestiary.
 * DELIBERATELY LOW: most unstatted NPCs a player attacks (clerks, guards,
 * townsfolk) are mundane, not level-appropriate bosses. The model is told to
 * pass a real `level` for anything tougher; the bestiary (later) gives exact stats.
 */
const DEFAULT_ENEMY_LEVEL = 0;

/** Resolves an enemy's level from the bestiary by name, else a low default. */
function enemyLevelFor(name: string): number {
  const rec = lookupLocalRule(name);
  if (rec && typeof rec.level === "number") return rec.level;
  return DEFAULT_ENEMY_LEVEL;
}

// Exportada para os testes unitários (use_item, guards) — o fluxo normal só a
// chama via runRulesStage.
export async function executeTool(
  session: Session,
  name: string,
  input: Record<string, unknown>,
  emit: (e: StreamEvent) => void,
): Promise<ToolOutcome> {
  switch (name) {
    case "roll_check": {
      const skill = String(input.skill ?? "");
      const reason = String(input.reason ?? skill);
      const combat = session.state.combat;
      const targetRef = input.target ? String(input.target) : "";

      // ATTACK path: a Strike against a target. Who is attacking is decided by
      // the target: a Strike ON the player comes from an enemy; a Strike on an
      // enemy comes from the player. This keeps things robust even if the model
      // loses track of whose "turn" it is.
      if (combat?.active && targetRef) {
        const target = findCombatant(combat, targetRef);
        if (!target) {
          const valid = combat.combatants
            .filter((c) => !c.defeated)
            .map((c) => `"${c.name}"`)
            .join(", ");
          return {
            content: `No combatant "${targetRef}" in this combat. Valid targets: ${valid}. Retry roll_check with one of these exact names.`,
            isError: true,
          };
        }
        const attacker =
          target.kind === "player" ? livingEnemy(combat) : playerOf(combat);
        if (!attacker) return { content: "No valid attacker for this Strike.", isError: true };
        if (attacker.defeated) {
          return { content: `${attacker.name} is defeated and cannot act.`, isError: true };
        }
        // Enforce the 3-action economy for the player's Strikes. `actions`
        // carries an activity's FULL cost (Sudden Charge = 2) — default 1.
        // A engine também detecta a atividade pelo nome no `reason` e cobra o
        // custo do dataset sozinha (o modelo esquecia o parâmetro): custo
        // cheio na 1ª rolagem da atividade, 0 nas seguintes do mesmo turno.
        const base = clampActionCost(input.actions);
        const activity =
          attacker.kind === "player" ? multiActionCost(`${reason} ${skill}`) : null;
        const chargedSet = turnActivityCharged.get(session);
        const cost = activity
          ? chargedSet?.has(activity.name)
            ? 0
            : Math.max(activity.cost, base)
          : base;
        if (attacker.kind === "player" && attacker.actionsRemaining < cost) {
          return {
            content: `ILLEGAL: this costs ${cost} action(s) but the player has only ${attacker.actionsRemaining} left this turn. It does NOT happen. Stop and end the turn.`,
            isError: true,
            summaryLine: `- ${titleCase(skill)} Strike: NOT taken — costs ${cost}, only ${attacker.actionsRemaining} action(s) left.`,
          };
        }
        // Requirements + Frequency do dataset: peek antes, commit depois de
        // todas as validações — só o que acontece de fato queima o limite.
        // `activity && cost === 0` = rolagem seguinte do MESMO uso (Twin Feint,
        // 2 Strikes): não conta como um segundo uso.
        if (attacker.kind === "player" && !(activity && cost === 0)) {
          const reqBlock = requirementBlocked(session, `${reason} ${skill}`);
          if (reqBlock) return reqBlock;
          const freqBlock = frequencyLimit(session, `${reason} ${skill}`);
          if (freqBlock) return freqBlock;
          commitFrequency(session, `${reason} ${skill}`);
        }
        if (activity && cost > 0) chargedSet?.add(activity.name);

        // Agile from DATA, not from the model: when the player's weapon is on
        // the sheet, its traits come from equipment.json and the model's
        // `agile` param is ignored. The param only counts for weapons the
        // engine can't identify (improvised, unarmed variants).
        let agile = input.agile === true;
        let agileSource = "model";
        if (attacker.kind === "player") {
          const sheetWeapon = findSheetWeapon(session.character, skill);
          if (sheetWeapon) {
            agile = itemTraits(sheetWeapon.name).includes("agile");
            agileSource = "sheet";
          }
        }
        const baseMod = combatAttackModifier(session, attacker, skill);
        const map = mapPenalty(attacker.mapProgress, agile);
        // Conditions as real mechanics: off-guard −2 AC, frightened −N to
        // the target's AC and to the attacker's rolls.
        const ac = effectiveAC(target);
        const statusPen = attackStatusPenalty(attacker);
        const mapLabel = map ? `, MAP ${map}` : "";
        const result = rollCheck(
          `${reason} (${skill} vs AC ${ac}${mapLabel})`,
          baseMod + map + statusPen,
          ac,
        );
        attacker.mapProgress += 1;
        attacker.actionsRemaining = Math.max(0, attacker.actionsRemaining - cost);

        const hit = result.degree === "success" || result.degree === "criticalSuccess";
        const crit = result.degree === "criticalSuccess";
        const critMiss = result.degree === "criticalFailure";
        const verb = crit ? "CRITICAL HIT" : hit ? "HIT" : critMiss ? "CRITICAL MISS" : "MISS";
        const outcome: AttackContext["outcome"] = crit
          ? "criticalHit"
          : hit
            ? "hit"
            : critMiss
              ? "criticalMiss"
              : "miss";
        const mapNote = map ? ` [MAP ${map}${agile ? ` agile:${agileSource}` : ""}]` : "";

        // On a hit, roll and apply damage automatically (no separate tool call).
        let damageLine = "";
        let dmg: { amount: number; type: string } | null = null;
        if (hit) {
          dmg = rollDamage(session, attacker, {
            weapon: skill,
            crit,
            damageType: input.damageType,
          });
          // Rogue Sneak Attack: extra d6s when striking an off-guard target.
          if (attacker.kind === "player") {
            const saDice = sneakAttackDice(session);
            if (isOffGuard(target) && saDice > 0) {
              const sneak = crit ? rollDice(saDice, 6) * 2 : rollDice(saDice, 6);
              dmg.amount += sneak;
            }
          }
          const before = target.currentHp;
          applyDamage(target, dmg.amount);
          turnStruck.get(session)?.add(target.id);
          if (target.kind === "player") session.state.currentHp = target.currentHp;
          let defeatedNote = target.defeated ? ` — ${target.name} DEFEATED` : "";
          if (target.kind === "player" && target.defeated) {
            defeatedNote = ` — ${enterDying(session, crit)}`;
          }
          damageLine = ` for ${dmg.amount} ${dmg.type}; ${target.name} ${before}→${target.currentHp} HP${defeatedNote}`;
        }
        // Emit the roll with full attack context so the UI can render it richly.
        result.attack = {
          attacker: attacker.name,
          target: target.name,
          attackerKind: attacker.kind,
          outcome,
          damage: dmg?.amount ?? null,
          damageType: dmg?.type ?? null,
        };
        emit({ type: "check", result });

        // Auto-close the fight when one side is wiped out (don't wait for end_turn).
        let endNote = "";
        if (combat.active) {
          const status = combatStatus(combat);
          if (status !== "ongoing") {
            combat.active = false;
            endNote = status === "victory" ? " Combat ends: VICTORY." : " Combat ends: DEFEAT.";
          }
        }
        emit({ type: "state", state: session.state });

        return {
          content: JSON.stringify({
            ...result,
            hit,
            crit,
            attacker: attacker.name,
            target: target.name,
            damage: dmg?.amount ?? 0,
            damageType: dmg?.type,
            targetHp: target.currentHp,
            targetDefeated: target.defeated,
            actionsLeft: attacker.kind === "player" ? attacker.actionsRemaining : undefined,
          }),
          summaryLine: `- ${titleCase(skill)} Strike: ${attacker.name} vs ${target.name}${mapNote} → ${verb}${damageLine}.${endNote}`,
        };
      }

      // Non-attack check (skill / save / Perception / Lore).
      const dc = Number(input.dc ?? 0);
      // Reject rolls without a real DC: `dc ?? 0` used to fabricate automatic
      // critical successes whenever the model forgot the argument.
      if (!isValidDc(dc)) {
        return {
          content:
            "No valid DC. Either set a real DC (very easy 10, easy 15, normal 20, hard 25, very hard 30) or DON'T roll — trivial actions and actions against helpless/dead targets simply succeed without a roll.",
          isError: true,
        };
      }
      const modifier = resolveModifier(session, skill);
      if (modifier === null) {
        return {
          content: `No check named "${skill}" on the sheet. Use an existing skill, save, perception, lore, or weapon name.`,
          isError: true,
        };
      }
      // In combat, skill actions (Demoralize, Tumble Through, Seek…) cost one
      // of the player's 3 actions — activities charge their full `actions`
      // cost. Saves default to FREE (reactions to effects), but a feat-action
      // resolved by a save (Shake it Off) passes `actions: 1` and pays it.
      const isSave = /^(fortitude|fort|reflex|ref|will)$/i.test(skill.trim());
      const skillBase = clampActionCost(input.actions, isSave ? 0 : 1);
      const skillActivity = combat?.active ? multiActionCost(`${reason} ${skill}`) : null;
      const skillCharged = turnActivityCharged.get(session);
      const skillCost = skillActivity
        ? skillCharged?.has(skillActivity.name)
          ? 0
          : Math.max(skillActivity.cost, skillBase)
        : skillBase;
      // Requirements + Frequency: peek antes de cobrar; rolagem seguinte do
      // mesmo uso (skillCost 0 com atividade já cobrada) não conta de novo.
      const skillFreqCounts = !(skillActivity && skillCost === 0);
      if (skillFreqCounts) {
        const reqBlock = requirementBlocked(session, `${reason} ${skill}`);
        if (reqBlock) return reqBlock;
        const freqBlock = frequencyLimit(session, `${reason} ${skill}`);
        if (freqBlock) return freqBlock;
      }
      if (combat?.active && skillCost > 0) {
        const you = playerOf(combat);
        if (you && !you.defeated) {
          if (you.actionsRemaining < skillCost) {
            return {
              content: `ILLEGAL: this costs ${skillCost} action(s) but the player has only ${you.actionsRemaining} left this turn. It does NOT happen. Stop and end the turn.`,
              isError: true,
              summaryLine: `- ${titleCase(skill)} check: NOT attempted — costs ${skillCost}, only ${you.actionsRemaining} action(s) left.`,
            };
          }
          you.actionsRemaining -= skillCost;
          if (skillActivity) skillCharged?.add(skillActivity.name);
          emit({ type: "state", state: session.state });
        }
      }
      if (skillFreqCounts) commitFrequency(session, `${reason} ${skill}`);
      const result = rollCheck(`${reason} (${skill} vs DC ${dc})`, modifier, dc);
      emit({ type: "check", result });
      return {
        content: JSON.stringify(result),
        summaryLine: `- ${checkReason(result.label)}: ${DEGREE_EN[result.degree]}.`,
      };
    }
    case "start_combat": {
      const raw = Array.isArray(input.enemies) ? input.enemies : [];
      const makeEnemies = (): Combatant[] => {
        const out: Combatant[] = [];
        for (const e of raw as Record<string, unknown>[]) {
          const eName = String(e?.name ?? "Enemy");
          const count = Math.max(1, Math.min(8, Number(e?.count ?? 1)));
          const level = e?.level != null ? Number(e.level) : enemyLevelFor(eName);
          for (let i = 0; i < count; i++) {
            out.push(enemyCombatant(count > 1 ? `${eName} ${i + 1}` : eName, level));
          }
        }
        return out;
      };

      // Combat already running: do NOT restart (that would wipe HP/initiative).
      // Instead let genuinely new foes join as reinforcements.
      const existing = session.state.combat;
      if (existing?.active) {
        const added: Combatant[] = [];
        for (const foe of makeEnemies()) {
          // Skip foes already in the fight (fuzzy match) so a re-issued
          // start_combat with a slightly different name can't spawn a duplicate.
          if (!hasCombatantNamed(existing, foe.name)) {
            existing.combatants.push(foe);
            added.push(foe);
          }
        }
        if (added.length) {
          existing.combatants.sort((a, b) => b.initiative - a.initiative);
          emit({ type: "state", state: session.state });
          return {
            content: `Combat already active; reinforcements joined: ${added.map((c) => c.name).join(", ")}.`,
            summaryLine: `- Reinforcements join the fight: ${added.map((c) => c.name).join(", ")}.`,
          };
        }
        return {
          content: "Combat is already active — did not restart. Use roll_check to act.",
        };
      }

      const player = playerCombatant(session.character, session.state.currentHp);
      const combat = buildCombat([player, ...makeEnemies()]);
      // This message is the player's turn: give them a full set of actions.
      if (player.actionsRemaining < 3) player.actionsRemaining = 3;
      // Combate novo zera os limites de Frequency de período longo (1/hour...).
      combatFrequencyUsed.set(session, new Map());
      session.state.combat = combat;
      emit({ type: "state", state: session.state });
      const order = combat.combatants
        .map((c) => `${c.name} (init ${c.initiative}, AC ${c.ac}, ${c.currentHp} HP)`)
        .join("; ");
      // Passivos aplicados pela engine ficam visíveis no resumo (auditoria).
      const passive = passiveFeatBonus(session.character, "initiative");
      const passiveNote = passive.total
        ? ` [+${passive.total} initiative from ${passive.sources.join(", ")}]`
        : "";
      return {
        content: `Combat started. Initiative order: ${order}${passiveNote}`,
        summaryLine: `- Combat begins (round 1). Initiative: ${order}.${passiveNote}`,
      };
    }
    case "end_turn": {
      const combat = session.state.combat;
      if (!combat?.active) return { content: "No active combat." };
      // The player passes with actions to spare. The rules stage will now run
      // the enemies' turns and then refresh the player for the next round.
      return { content: "The player ends their turn.", endedTurn: true };
    }
    case "end_combat": {
      const combat = session.state.combat;
      if (!combat?.active) return { content: "No active combat." };
      const reason = String(input.reason ?? "the fight is over");
      combat.active = false;
      emit({ type: "state", state: session.state });
      return {
        content: `Combat is over (${reason}). Back to free narration.`,
        summaryLine: `- Combat ends: ${reason}.`,
      };
    }
    case "spend_actions": {
      const combat = session.state.combat;
      if (!combat?.active) {
        return { content: "No active combat — outside encounters actions aren't tracked. Nothing spent." };
      }
      const you = playerOf(combat);
      if (!you || you.defeated) return { content: "No active player combatant.", isError: true };
      const reason = String(input.reason ?? "activity");
      // Uso de ITEM tem tool própria: use_item verifica a ficha, gasta a
      // quantidade de verdade e resolve o efeito real. spend_actions para item
      // criaria um caminho paralelo sem contador — redireciona sempre.
      const itemWord = reason.match(
        /\b(potion|elixir|tonic|flask|bomb|alchemical|acid|scroll|oil|talisman|antidote|antiplague)\b/i,
      )?.[0];
      if (itemWord) {
        return {
          content: `Use the use_item tool for items ("${itemWord}"): it checks the Equipment, spends the real quantity, and resolves the real effect. No action was spent here — retry with use_item.`,
          isError: true,
        };
      }
      // O dataset manda no custo quando o reason cita a atividade (o modelo
      // chamou spend_actions com 1 para Improvised Repair, que custa 3).
      const spendActivity = multiActionCost(reason);
      const spendCharged = turnActivityCharged.get(session);
      // Requirements + Frequency: peek antes de cobrar, commit após.
      const spendReqBlock = requirementBlocked(session, reason);
      if (spendReqBlock) return spendReqBlock;
      const spendFreqBlock = frequencyLimit(session, reason);
      if (spendFreqBlock) return spendFreqBlock;
      const cost =
        spendActivity && !spendCharged?.has(spendActivity.name)
          ? Math.max(spendActivity.cost, clampActionCost(input.actions))
          : clampActionCost(input.actions);
      if (you.actionsRemaining < cost) {
        return {
          content: `ILLEGAL: this costs ${cost} action(s) but the player has only ${you.actionsRemaining} left this turn. It does NOT happen.`,
          isError: true,
          summaryLine: `- ${reason}: NOT done — costs ${cost}, only ${you.actionsRemaining} action(s) left.`,
        };
      }
      // Só marca a atividade como paga DEPOIS de cobrar de fato (uma rejeição
      // não pode transformar a próxima tentativa em custo reduzido).
      if (spendActivity) spendCharged?.add(spendActivity.name);
      you.actionsRemaining -= cost;
      commitFrequency(session, reason);
      emit({ type: "state", state: session.state });
      return {
        content: `Spent ${cost} action(s) on: ${reason}. ${you.actionsRemaining} remaining this turn.`,
        summaryLine: `- ${reason} (${cost} action${cost > 1 ? "s" : ""} spent).`,
      };
    }
    case "use_item": {
      const itemName = String(input.item ?? "").trim();
      const reason = String(input.reason ?? itemName);
      if (!itemName) {
        return { content: "Missing 'item': pass the Equipment item's name.", isError: true };
      }
      // Grounding: o item PRECISA estar no Equipment com quantidade > 0. A
      // mão vazia é mostrada em ficção pelo narrador (summaryLine).
      const equipment = session.character.equipment;
      const key = itemName.toLowerCase();
      const owned =
        equipment.find((e) => e.name.toLowerCase() === key) ??
        equipment.find(
          (e) =>
            key.includes(e.name.toLowerCase()) || e.name.toLowerCase().includes(key),
        );
      if (!owned || owned.qty <= 0) {
        const carried =
          equipment
            .filter((e) => e.qty > 0)
            .map((e) => (e.qty > 1 ? `${e.name} x${e.qty}` : e.name))
            .join(", ") || "nothing";
        return {
          content: `REJECTED: no "${itemName}" in the character's Equipment (carried: ${carried}). It does NOT exist in their hands and nothing is spent. Resolve the turn without it.`,
          isError: true,
          summaryLine: `- Use ${itemName}: FAILED — no such item in the Equipment; their hand finds nothing.`,
        };
      }

      const combat = session.state.combat;
      const you = combat?.active ? playerOf(combat) : null;
      const inCombat = !!you && !you.defeated;
      const record = itemRecord(owned.name);
      const traits = record?.traits ?? [];
      const isBomb = traits.includes("bomb") && !!record?.damage;
      // Tolera palavras entre a fórmula e "Hit Points" ("regain 1d8 healing
      // Hit Points" — o tipo vem do @Damage do Foundry).
      const healMatch = record
        ? /(\d+)d(\d+)(?:\s*\+\s*(\d+))?[^.]{0,40}?(?:hit points|hp)\b/i.exec(record.text)
        : null;
      const isHealing =
        !!healMatch && /potion|elixir|oil|healing/i.test(`${owned.name} ${traits.join(" ")}`);

      // Custo RAW em combate: sacar (Interact) + usar. Itens sem mecânica
      // própria (tocha, corda) cobram só o Interact.
      const cost = inCombat ? (isBomb || isHealing ? 2 : 1) : 0;
      if (inCombat && you!.actionsRemaining < cost) {
        return {
          content: `ILLEGAL: using ${owned.name} costs ${cost} action(s) (draw + use) but the player has only ${you!.actionsRemaining} left this turn. It does NOT happen.`,
          isError: true,
          summaryLine: `- Use ${owned.name}: NOT done — costs ${cost} action(s), only ${you!.actionsRemaining} left.`,
        };
      }
      const consume = () => {
        owned.qty -= 1;
        if (owned.qty <= 0) equipment.splice(equipment.indexOf(owned), 1);
      };
      const qtyNote = () =>
        owned.qty > 0 ? `${owned.qty} left` : `that was the last one`;

      // BOMBA: Strike de arremesso com o statblock REAL do item (dataset) —
      // não os stats da arma da ficha (bug do smoke de 2026-07-05).
      if (isBomb) {
        if (!inCombat || !input.target) {
          return {
            content: `"${owned.name}" is a bomb: in combat, pass 'target' and the engine resolves a real Strike with its statblock. Outside combat there is nothing to hit — don't consume it idly.`,
            isError: true,
          };
        }
        const target = findCombatant(combat!, String(input.target));
        if (!target) {
          const valid = combat!.combatants
            .filter((c) => !c.defeated)
            .map((c) => `"${c.name}"`)
            .join(", ");
          return {
            content: `No combatant "${String(input.target)}". Valid targets: ${valid}. Retry use_item with one of these exact names.`,
            isError: true,
          };
        }
        you!.actionsRemaining -= cost;
        const atkBonus = bombAttackBonus(session.character, record!);
        const map = mapPenalty(you!.mapProgress, traits.includes("agile"));
        const ac = effectiveAC(target);
        const statusPen = attackStatusPenalty(you!);
        const mapLabel = map ? `, MAP ${map}` : "";
        const result = rollCheck(
          `${reason} (${owned.name} vs AC ${ac}${mapLabel})`,
          atkBonus + map + statusPen,
          ac,
        );
        you!.mapProgress += 1;
        const hit = result.degree === "success" || result.degree === "criticalSuccess";
        const crit = result.degree === "criticalSuccess";
        const verb = crit ? "CRITICAL HIT" : hit ? "HIT" : result.degree === "criticalFailure" ? "CRITICAL MISS" : "MISS";
        let damageLine = "";
        let dmg: { amount: number; type: string } | null = null;
        if (hit) {
          const base = rollDice(record!.damage!.dice, parseDie(record!.damage!.die));
          let amount = crit ? base * 2 : base;
          if (record!.splash) amount += record!.splash;
          dmg = { amount, type: record!.damage!.type };
          const before = target.currentHp;
          applyDamage(target, amount);
          turnStruck.get(session)?.add(target.id);
          let extra = "";
          if (record!.persistent) {
            const pcond = `persistent ${record!.persistent.type} damage ${record!.persistent.number}`;
            if (!target.conditions.includes(pcond)) target.conditions.push(pcond);
            extra = ` + ${pcond}`;
          }
          if (record!.splash) extra += ` (incl. ${record!.splash} splash)`;
          const defeatedNote = target.defeated ? ` — ${target.name} DEFEATED` : "";
          damageLine = ` for ${amount} ${dmg.type}${extra}; ${target.name} ${before}→${target.currentHp} HP${defeatedNote}`;
        }
        consume(); // a bomba se foi mesmo errando o arremesso
        result.attack = {
          attacker: you!.name,
          target: target.name,
          attackerKind: "player",
          outcome: crit ? "criticalHit" : hit ? "hit" : result.degree === "criticalFailure" ? "criticalMiss" : "miss",
          damage: dmg?.amount ?? null,
          damageType: dmg?.type ?? null,
        };
        emit({ type: "check", result });
        let endNote = "";
        if (combat!.active && combatStatus(combat!) !== "ongoing") {
          combat!.active = false;
          endNote = " Combat ends: VICTORY.";
        }
        emit({ type: "state", state: session.state });
        return {
          content: JSON.stringify({
            ...result,
            hit,
            crit,
            damage: dmg?.amount ?? 0,
            targetHp: target.currentHp,
            itemQtyLeft: owned.qty > 0 ? owned.qty : 0,
            actionsLeft: you!.actionsRemaining,
          }),
          summaryLine: `- ${owned.name} thrown: ${you!.name} vs ${target.name}${map ? ` [MAP ${map}]` : ""} → ${verb}${damageLine}. Bomb spent (${qtyNote()}).${endNote}`,
        };
      }

      // CURA: a engine rola a fórmula do texto do item e aplica capada.
      if (isHealing) {
        if (inCombat) you!.actionsRemaining -= cost;
        const dice = Number(healMatch![1]);
        const faces = Number(healMatch![2]);
        const flat = healMatch![3] ? Number(healMatch![3]) : 0;
        const healed = rollDice(dice, faces) + flat;
        const s = session.state;
        const before = s.currentHp;
        s.currentHp = Math.min(session.character.maxHp, s.currentHp + healed);
        if (combat) {
          const pc = playerOf(combat);
          if (pc) pc.currentHp = s.currentHp;
        }
        consume();
        emit({ type: "state", state: s });
        return {
          content: `Consumed ${owned.name}: healed ${s.currentHp - before} HP (${before}→${s.currentHp}/${session.character.maxHp}). ${qtyNote()}.${inCombat ? ` ${you!.actionsRemaining} action(s) left.` : ""}`,
          summaryLine: `- ${owned.name} consumed: heals ${s.currentHp - before} HP (${before}→${s.currentHp}/${session.character.maxHp}); ${qtyNote()}.`,
        };
      }

      // Item sem mecânica própria: só CONSUMÍVEIS (trait do dataset) gastam
      // quantidade — corda/tocha continuam no inventário.
      if (inCombat) you!.actionsRemaining -= cost;
      const isConsumable = traits.includes("consumable");
      if (isConsumable) consume();
      if (inCombat) emit({ type: "state", state: session.state });
      const spentNote = isConsumable ? ` Consumed (${qtyNote()}).` : "";
      return {
        content: `Used ${owned.name}.${spentNote} No mechanical effect — narrate its use.`,
        summaryLine: `- ${owned.name} used.${spentNote}`,
      };
    }
    case "lookup_rule": {
      const query = String(input.query ?? "");
      const local = lookupLocalRule(query);
      if (local) {
        const traits = local.traits?.length ? ` [${local.traits.join(", ")}]` : "";
        return {
          content: `${local.name} (${local.category})${traits}\n${local.text}`,
        };
      }
      const web = await lookupWebRule(query);
      if (web) {
        return {
          content: `[Archives of Nethys: ${web.url}]\n${web.name} (${web.category}): ${web.text}`,
        };
      }
      return {
        content: `No entry for "${query}" in the local dataset or AoN. Use your general PF2e knowledge and stay consistent.`,
      };
    }
    case "get_character": {
      return { content: characterSheetBlock(session.character) };
    }
    case "update_state": {
      const s = session.state;
      const combat = s.combat;
      const targetRef = input.target ? String(input.target) : "";

      // Contrato estrito: parâmetro desconhecido não pode ser engolido em
      // silêncio (play-test: `updateType: "off-guard"` foi ignorado e o
      // off-guard do Twin Feint nunca aplicou — a 2ª Strike rolou vs AC cheia).
      const KNOWN_PARAMS = new Set(["hpDelta", "addConditions", "removeConditions", "target"]);
      const unknown = Object.keys(input).filter((k) => !KNOWN_PARAMS.has(k));
      const hasEffect =
        typeof input.hpDelta === "number" ||
        Array.isArray(input.addConditions) ||
        Array.isArray(input.removeConditions);
      if (unknown.length > 0 && !hasEffect) {
        return {
          content: `Unknown parameter(s) ${unknown.map((k) => `"${k}"`).join(", ")} — NOTHING was applied. Valid parameters: hpDelta (number), addConditions (string[]), removeConditions (string[]), target (combatant id/name). To apply a condition, retry with addConditions, e.g. {"target":"${targetRef || "..."}","addConditions":["off-guard"]}.`,
          isError: true,
        };
      }

      // Cura EM COMBATE exige uma fonte real na ficha (regras-como-dados): o
      // modelo curou o jogador com uma "poção" que não existia no inventário.
      // Fora de combate o descanso continua livre (regra RAW já ensinada).
      if (
        typeof input.hpDelta === "number" &&
        input.hpDelta > 0 &&
        combat?.active
      ) {
        const gear = session.character.equipment;
        // Toolkit habilita cura por HABILIDADE (Battle Medicine, RAW exige o
        // healer's toolkit) → hpDelta permitido. Consumível bebível é papel do
        // use_item (contador real). Nada dos dois → cura não existe.
        const toolkit = gear.some((e) => /healer'?s (toolkit|kit|tools)/i.test(e.name));
        const drinkable = gear.some((e) => /potion|elixir|tonic|salve|balm/i.test(e.name));
        if (!toolkit && !drinkable) {
          return {
            content: `REJECTED: no healing source in the character's Equipment (no potion/elixir/healer's toolkit). In-combat healing needs a real item or ability — without one, ${session.character.name} does NOT heal. Resolve the rest of the turn without it.`,
            isError: true,
            summaryLine: `- Healing attempt: FAILED — no healing item in the character's Equipment; no HP recovered.`,
          };
        }
        if (!toolkit) {
          return {
            content: `Use the use_item tool to heal with a consumable: it spends the real quantity and rolls the item's real dice. NOTHING was applied here — retry with use_item (e.g. {"item":"Healing Potion (Minor)","reason":"drink it"}). hpDelta is only for healing abilities backed by the sheet (Battle Medicine with a healer's toolkit, a spell).`,
            isError: true,
          };
        }
      }

      // Whitelist de condições (regras-como-dados): só as 44 oficiais entram
      // no estado. História-como-condição ("companion: Cat") é rejeitada —
      // fatos de história vivem na narrativa, não na mecânica.
      let addConds: string[] = [];
      if (Array.isArray(input.addConditions)) {
        addConds = (input.addConditions as unknown[]).map((c) => String(c).toLowerCase().trim());
        const invalid = addConds.filter((c) => !isOfficialCondition(c));
        if (invalid.length > 0) {
          return {
            content: `REJECTED: ${invalid.map((c) => `"${c}"`).join(", ")} ${invalid.length > 1 ? "are" : "is"} not a PF2e condition — NOTHING was applied. Only official conditions go in state (closest: ${conditionSuggestions(invalid[0]!)}). Story facts are NOT conditions; keep them in the narrative. Retry with official conditions only, e.g. {"addConditions":["frightened 1"]}.`,
            isError: true,
          };
        }
      }

      // Combat: target a specific combatant (enemy/ally/player).
      if (combat?.active && targetRef) {
        const target = findCombatant(combat, targetRef);
        if (!target) {
          const valid = combat.combatants.map((c) => `"${c.name}"`).join(", ");
          return {
            content: `No combatant "${targetRef}". Valid targets: ${valid}. Retry with one of these exact names.`,
            isError: true,
          };
        }
        if (typeof input.hpDelta === "number") {
          // Dupla contagem: a engine JÁ aplicou o dano da(s) Strike(s) deste
          // turno — reaplicar via hpDelta dobrava o dano (caso Double Shot).
          if (input.hpDelta < 0 && turnStruck.get(session)?.has(target.id)) {
            return {
              content: `REJECTED: ${target.name} already took this turn's Strike damage — the engine applies it automatically. Do NOT re-apply it with hpDelta. Only use hpDelta for a SEPARATE effect (trap, hazard, persistent damage).`,
              isError: true,
            };
          }
          if (input.hpDelta < 0) applyDamage(target, -input.hpDelta);
          else target.currentHp = Math.min(target.maxHp, target.currentHp + input.hpDelta);
        }
        for (const cond of addConds) {
          if (!target.conditions.includes(cond)) target.conditions.push(cond);
        }
        if (Array.isArray(input.removeConditions)) {
          // Leniente: remover o que não está lá é no-op, sem whitelist.
          const remove = new Set(
            (input.removeConditions as unknown[]).map((c) => String(c).toLowerCase().trim()),
          );
          target.conditions = target.conditions.filter((c) => !remove.has(c.toLowerCase()));
        }
        if (target.kind === "player") s.currentHp = target.currentHp;
        emit({ type: "state", state: s });
        return {
          content: `Updated ${target.name}: HP ${target.currentHp}/${target.maxHp}, conditions [${target.conditions.join(", ")}].`,
        };
      }

      // Target explícito que NÃO resolveu para um combatente ativo (combate
      // já fechou, alvo morto): nunca cair no estado do jogador — o -12
      // mirado no "Bandit" recém-morto drenava o HP do Ferro (bateria
      // 2026-07-06, Dual-Handed Assault).
      if (targetRef) {
        const isSelf =
          targetRef.toLowerCase().includes(session.character.name.toLowerCase()) ||
          /^(player|me|self|myself)$/i.test(targetRef.trim());
        if (!isSelf) {
          return {
            content: `NOTHING was changed: no active combatant "${targetRef}" (the fight may already be over — the engine had applied all Strike damage). Do not re-apply damage. update_state without a target only touches the PLAYER's own state.`,
            isError: true,
          };
        }
      }

      // Default: the player's persistent state.
      if (typeof input.hpDelta === "number") {
        s.currentHp = Math.max(
          0,
          Math.min(session.character.maxHp, s.currentHp + input.hpDelta),
        );
      }
      for (const cond of addConds) {
        if (!s.conditions.includes(cond)) s.conditions.push(cond);
      }
      if (Array.isArray(input.removeConditions)) {
        const remove = new Set(
          (input.removeConditions as unknown[]).map((c) => String(c).toLowerCase().trim()),
        );
        s.conditions = s.conditions.filter((c) => !remove.has(c.toLowerCase()));
      }
      // Keep the player's combatant HP in sync during combat.
      if (combat) {
        const pc = playerOf(combat);
        if (pc) pc.currentHp = s.currentHp;
      }
      emit({ type: "state", state: s });
      return { content: `State updated: HP ${s.currentHp}/${session.character.maxHp}.` };
    }
    default:
      return { content: `Unknown tool: ${name}`, isError: true };
  }
}

/**
 * Resolves every living enemy's turn DETERMINISTICALLY (no model call): each
 * enemy makes up to two Strikes at the player using benchmark attack/damage and
 * MAP, applying HP loss. Returns the summary lines. Ends combat on the player's
 * defeat. This runs automatically at the end of the player's turn.
 */
export function resolveEnemyTurns(
  session: Session,
  emit: (e: StreamEvent) => void,
): string[] {
  const combat = session.state.combat;
  const lines: string[] = [];
  if (!combat?.active) return lines;
  const player = playerOf(combat);
  if (!player) return lines;

  // Strict initiative: enemies act AFTER the player's turn, ordered so that
  // those SLOWER than the player finish this round first, and those FASTER than
  // the player act LAST — i.e. right before the player's next turn (the correct
  // spot for a higher-initiative foe in the round cycle). combat.combatants is
  // already sorted by initiative (desc), so each subset keeps that order.
  const living = combat.combatants.filter((c) => c.kind === "enemy" && !c.defeated);
  const slower = living.filter((e) => e.initiative <= player.initiative);
  const faster = living.filter((e) => e.initiative > player.initiative);
  const order = [...slower, ...faster];

  for (const enemy of order) {
    enemy.mapProgress = 0;
    const b = benchmark(enemy.level ?? 0);
    for (let strike = 0; strike < 2; strike++) {
      if (player.defeated) break;
      const map = mapPenalty(enemy.mapProgress);
      // Same condition math as player Strikes (off-guard/frightened both ways).
      const ac = effectiveAC(player);
      const label = `${enemy.name} Strike vs ${player.name} (AC ${ac}${map ? `, MAP ${map}` : ""})`;
      const result = rollCheck(label, b.attack + map + attackStatusPenalty(enemy), ac);
      enemy.mapProgress += 1;
      const crit = result.degree === "criticalSuccess";
      const hit = crit || result.degree === "success";
      let dmgLine = "";
      let amount: number | null = null;
      if (hit) {
        amount = rollDice(b.damage.dice, b.damage.faces) + b.damage.bonus;
        if (crit) amount *= 2;
        const before = player.currentHp;
        applyDamage(player, amount);
        session.state.currentHp = player.currentHp;
        const down = player.defeated ? ` — ${enterDying(session, crit)}` : "";
        dmgLine = ` for ${amount}; ${player.name} ${before}→${player.currentHp} HP${down}`;
      }
      const verb = crit ? "CRITICAL HIT" : hit ? "HIT" : "MISS";
      result.attack = {
        attacker: enemy.name,
        target: player.name,
        attackerKind: "enemy",
        outcome: crit ? "criticalHit" : hit ? "hit" : "miss",
        damage: amount,
        damageType: null,
      };
      emit({ type: "check", result });
      lines.push(
        `- ${enemy.name} Strike vs ${player.name}${map ? ` [MAP ${map}]` : ""} → ${verb}${dmgLine}.`,
      );
      emit({ type: "state", state: session.state });
    }
    if (player.defeated) break;
  }

  const status = combatStatus(combat);
  if (status !== "ongoing") {
    combat.active = false;
    lines.push(
      status === "defeat"
        ? "- Combat ends: DEFEAT — you fall."
        : "- Combat ends: VICTORY.",
    );
  } else {
    // A full round just completed (player + every enemy). Advance the counter.
    combat.round += 1;
  }
  emit({ type: "state", state: session.state });
  return lines;
}

/**
 * Live combat state injected into the rules stage so the model always knows the
 * fight is ongoing, whose HP is what, and how many actions the player has left.
 * Returns "" when not in combat.
 */
function combatStateBlock(session: Session): string {
  const combat = session.state.combat;
  if (!combat?.active) return "";
  const you = playerOf(combat);
  const roster = combat.combatants
    .map((c) => {
      const cond = c.conditions.length ? `, ${c.conditions.join(", ")}` : "";
      const dead = c.defeated ? " — DEFEATED" : "";
      return `- ${c.name} [id:${c.id}] (${c.kind}): ${c.currentHp}/${c.maxHp} HP, AC ${c.ac}${cond}${dead}`;
    })
    .join("\n");
  const nextMap = you ? mapPenalty(you.mapProgress) : 0;
  return [
    `# CURRENT COMBAT — round ${combat.round}. Combat is ALREADY ACTIVE: do NOT call start_combat again (only call it to add brand-new reinforcements).`,
    you
      ? `This message is the PLAYER'S TURN: they have ${you.actionsRemaining} of 3 actions left; the next Strike's MAP is ${nextMap}. Each Strike costs 1 action. Resolve ONLY the actions the player declared, and NEVER more than 3 actions — if they try, the extra Strike is rejected.`
      : "",
    "Combatants:",
    roster,
    "To attack, call roll_check with the target's id/name; on a hit the engine applies damage automatically. Do NOT roll for the enemies — after the player's turn the engine resolves the enemies' Strikes back at the player automatically. Only call end_turn if the player passes or ends with actions to spare. If the fight is over without a kill (foes flee/surrender/are spared, or the player disengages and the scene moves on), you MUST call end_combat — never keep resolving non-combat messages inside a stale combat.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * STAGE 1 — Rules: the rules model resolves the mechanics via tool use (no
 * narration). Emits `check`/`state` events but NOT `delta`. Runs on its own
 * message history (doesn't pollute the narrative dialogue) and returns the
 * mechanical summary.
 */
async function runRulesStage(
  session: Session,
  emit: (e: StreamEvent) => void,
): Promise<string> {
  // Snapshot the player's persistent state so the summary can tell the
  // narrator whether it actually CHANGED this turn (stale "HP 56/65" lines made
  // the narrator dramatize old wounds out of nowhere).
  const hpBefore = session.state.currentHp;
  const condsBefore = session.state.conditions.join("|");

  // Morto é morto: sem mecânica a resolver — o narrador conduz o epílogo.
  if (session.state.conditions.some((c) => /^dead$/i.test(c))) {
    return `${session.character.name} is DEAD. No mechanics remain — narrate the aftermath; this character's story has ended.`;
  }

  // Caído (dying): inconsciente não age — o turno É o recovery check (RAW:
  // flat check DC 10+dying; crit −2, sucesso −1, falha +1, crit falha +2;
  // dying 4 = morte). Desvio deliberado p/ jogo solo: estabilizar acorda o
  // personagem com 1 HP e wounded +1 (RAW ficaria 0 HP inconsciente — um
  // limbo injogável sem aliados para curar).
  const dyingNow = conditionValueIn(session.state.conditions, "dying");
  if (session.state.currentHp <= 0 && dyingNow > 0) {
    const die = rollDice(1, 20);
    const { degree, newDying } = applyRecovery(die, dyingNow);
    emit({
      type: "check",
      result: {
        label: `Recovery check (flat d20 vs DC ${10 + dyingNow})`,
        die,
        modifier: 0,
        total: die,
        dc: 10 + dyingNow,
        degree,
      },
    });
    let line: string;
    if (newDying >= 4) {
      session.state.conditions = ["dead"];
      line = `Recovery check: ${DEGREE_EN[degree]} (d20 ${die} vs DC ${10 + dyingNow}) — dying reaches 4. ${session.character.name} DIES. This is final.`;
    } else if (newDying === 0) {
      const wounded = conditionValueIn(session.state.conditions, "wounded") + 1;
      let conds = setValuedCondition(session.state.conditions, "dying", 0);
      conds = conds.filter((c) => !/^unconscious$/i.test(c));
      session.state.conditions = setValuedCondition(conds, "wounded", wounded);
      session.state.currentHp = 1;
      line = `Recovery check: ${DEGREE_EN[degree]} (d20 ${die} vs DC ${10 + dyingNow}) — ${session.character.name} STABILIZES: conscious again at 1 HP, wounded ${wounded}. They wake battered, on the ground, moments later.`;
    } else {
      session.state.conditions = setValuedCondition(
        session.state.conditions,
        "dying",
        newDying,
      );
      line = `Recovery check: ${DEGREE_EN[degree]} (d20 ${die} vs DC ${10 + dyingNow}) — still unconscious, DYING ${newDying} of 4. The player cannot act; narrate only what their fading senses catch.`;
    }
    emit({ type: "state", state: session.state });
    return `1. ${line}`;
  }

  // Each player message is their turn: refresh actions/MAP so they get a fresh
  // 3 actions (and enemies reset MAP) before resolving this turn's Strikes.
  turnStruck.set(session, new Set());
  turnActivityCharged.set(session, new Set());
  turnFrequencyUsed.set(session, new Map());
  if (session.state.combat?.active) {
    beginPlayerRound(session.state.combat);
    emit({ type: "state", state: session.state });
  }

  // Context: system prompt + sheet + (if fighting) the LIVE combat state, so the
  // model KNOWS combat is already active and never re-runs start_combat.
  const combatBlock = combatStateBlock(session);
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: [
        RULES_SYSTEM_PROMPT,
        characterSheetBlock(session.character),
        combatBlock,
      ]
        .filter(Boolean)
        .join("\n\n"),
    },
    ...session.messages.slice(-RULES_CONTEXT_TURNS),
  ];

  // We collect the REAL tool results and build the summary in code
  // (deterministic, concise) — the rules model's prose is ignored. Each tool
  // returns a player-safe `summaryLine`; we keep them in call order so the
  // narrator sees an explicit hit/miss/damage story, not just "failure".
  const summaryLines: string[] = [];
  const consulted: string[] = [];
  let anyTool = false;
  let endedTurn = false;
  let mechanicalResolved = false;

  /** One rules-model exchange: executes any tool calls, returns how many. */
  const runIteration = async (iterLabel: string): Promise<number> => {
    // The rules stage doesn't stream to the client (no delta events), so a
    // single non-streaming completion keeps the tool_calls easy to read.
    const resp = await client.chat.completions.create({
      model: RULES_MODEL,
      messages,
      tools: TOOLS,
      temperature: 0.3,
      ...NO_REASONING,
    });
    const message = resp.choices[0]?.message;
    const toolCalls = message?.tool_calls ?? [];
    console.log(
      `[GM][rules] iter ${iterLabel}: text=${message?.content?.length ?? 0} chars, tools=[${toolCalls
        .map((t) => t.function.name)
        .join(", ")}]`,
    );

    // Push the assistant message verbatim (it carries the tool_calls + ids).
    if (message) messages.push(message);

    if (toolCalls.length === 0) return 0;
    anyTool = true;

    for (const tc of toolCalls) {
      const args = parseToolArgs(tc.function.arguments);
      const outcome = await executeTool(session, tc.function.name, args, emit);
      console.log(
        `[GM][rules]   tool ${tc.function.name}(${JSON.stringify(args)}) -> ${
          outcome.isError ? "ERROR: " : ""
        }${outcome.content.slice(0, 80)}`,
      );
      if (outcome.summaryLine) summaryLines.push(outcome.summaryLine);
      if (outcome.endedTurn) endedTurn = true;
      if (
        !outcome.isError &&
        ["roll_check", "use_item", "spend_actions", "update_state", "start_combat", "end_combat"].includes(
          tc.function.name,
        )
      ) {
        mechanicalResolved = true;
      }
      if (tc.function.name === "lookup_rule" && !outcome.isError) {
        consulted.push(outcome.content.split("\n")[0]!.slice(0, 80));
      }

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: outcome.content,
      });
    }
    return toolCalls.length;
  };

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if ((await runIteration(String(i))) === 0) break;
  }

  // SECOND CHANCE (code-enforced): a fight is live and the model resolved
  // NOTHING for this message. In play-tests that was almost never "the player
  // is just talking" — it was the model forgetting to act or to call
  // end_combat, leaving a zombie combat behind. Force an explicit decision.
  {
    const liveCombat = session.state.combat;
    const player = liveCombat?.active ? playerOf(liveCombat) : undefined;
    if (player && player.actionsRemaining === 3 && !endedTurn) {
      messages.push({
        role: "user",
        content:
          "[ENGINE CHECK] Combat is still ACTIVE but you resolved NO actions for the player's message. Decide now: (a) the message describes attacks or checks → resolve them with roll_check; (b) it is an activity/feat WITHOUT a roll → you still MUST pay its cost with spend_actions (and apply its effect with update_state); (c) the message means the fight is over (fleeing, disengaging, sparing, surrender, foes gone) → call end_combat; (d) the player is genuinely only speaking mid-combat → reply exactly 'dialogue only'. Never leave a fight hanging when the story has moved past it.",
      });
      for (let i = 0; i < 3; i++) {
        if ((await runIteration(`recheck${i}`)) === 0) break;
      }
    }
  }

  // SECOND CHANCE fora de combate (escada de escalação: o prompt "atividades
  // nunca são narração pura" reincidiu — Goblin Song na bateria 2026-07-06):
  // o jogador invocou uma atividade COM regras e nada mecânico foi resolvido.
  if (!session.state.combat?.active && !mechanicalResolved) {
    const lastUser = [...session.messages]
      .reverse()
      .find((m) => m.role === "user");
    const invoked =
      typeof lastUser?.content === "string" ? namedActivity(lastUser.content) : null;
    if (invoked) {
      messages.push({
        role: "user",
        content: `[ENGINE CHECK] The player invoked "${invoked}", which has RULES (an action, usually with a check), but you resolved NOTHING mechanically. Resolve it now: roll_check with its listed skill vs a real DC (lookup_rule first if unsure) and apply any effect with update_state. Only if it truly cannot apply in this scene, answer in one line why.`,
      });
      for (let i = 0; i < 2; i++) {
        if ((await runIteration(`activity-recheck${i}`)) === 0) break;
      }
    }
  }

  // The player's whole turn is this one message. If they actually spent an
  // action (a Strike decrements actionsRemaining below 3) or explicitly ended,
  // the enemies take their turn NOW — resolved deterministically in code.
  const combat = session.state.combat;
  const you = combat ? playerOf(combat) : undefined;
  const enemiesAlive =
    combat?.combatants.some((c) => c.kind === "enemy" && !c.defeated) ?? false;
  const tookTurn = endedTurn || (you ? you.actionsRemaining < 3 : false);
  if (combat?.active && enemiesAlive && tookTurn) {
    summaryLines.push(...resolveEnemyTurns(session, emit));
    // End-of-round upkeep: off-guard expires, frightened N decrements.
    if (combat.active) {
      tickEndOfRound(combat);
      emit({ type: "state", state: session.state });
    }
  }

  const stateChanged =
    session.state.currentHp !== hpBefore ||
    session.state.conditions.join("|") !== condsBefore;
  return buildMechanicalSummary(session, summaryLines, consulted, anyTool, stateChanged);
}

/** OpenAI returns tool-call arguments as a JSON string; parse defensively. */
function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const DEGREE_EN: Record<CheckResult["degree"], string> = {
  criticalSuccess: "critical success",
  success: "success",
  failure: "failure",
  criticalFailure: "critical failure",
};

/** Strips the "(skill vs DC n)" suffix so only the plain reason remains. */
function checkReason(label: string): string {
  return label.split(" (")[0]!.trim();
}

/**
 * Builds a short, player-safe mechanical summary from the tool results. It
 * deliberately omits rules jargon (no "DC", "total", or die numbers) so that
 * if the narrative model leaks this block verbatim, nothing breaks immersion.
 */
function buildMechanicalSummary(
  session: Session,
  summaryLines: string[],
  consulted: string[],
  anyTool: boolean,
  stateChanged: boolean,
): string {
  const combat = session.state.combat;
  if (
    summaryLines.length === 0 &&
    consulted.length === 0 &&
    !anyTool &&
    !combat?.active
  ) {
    return "No roll was needed this turn.";
  }
  // Number multi-event turns (and all combat turns) — a numbered list is much
  // harder for the narrator to skip or merge than a wall of dashes.
  const lines: string[] =
    combat?.active || summaryLines.length >= 2
      ? summaryLines.map((l, i) => `${i + 1}. ${l.replace(/^- /, "")}`)
      : [...summaryLines];
  // In combat, an empty turn is a fact the narrator MUST respect: without this
  // line it "helpfully" invents blows that never happened (and the state
  // contradicts the story). Happens when every tool call errored out.
  if (combat?.active && summaryLines.length === 0) {
    lines.unshift(
      "NOTHING was resolved this turn: no attack happened, nobody was hit, no damage was dealt. Narrate only hesitation or repositioning — do NOT invent any blow, wound, or damage.",
    );
  }
  if (consulted.length) {
    lines.push(`Rules consulted: ${consulted.join("; ")}.`);
  }
  if (combat?.active) {
    const roster = combat.combatants
      .map(
        (c) =>
          `${c.name} ${c.currentHp}/${c.maxHp} HP${
            c.conditions.length ? ` [${c.conditions.join(", ")}]` : ""
          }${c.defeated ? " (defeated)" : ""}`,
      )
      .join("; ");
    const you = playerOf(combat);
    if (you) {
      lines.push(`Player has ${you.actionsRemaining} of 3 actions unused this turn.`);
    }
    lines.push(`Combat: round ${combat.round}. ${roster}.`);
  }
  // Only surface the player's persistent state when it CHANGED this turn —
  // repeating stale HP every turn led the narrator to invent phantom aches.
  if (stateChanged) {
    const st = session.state;
    const cond = st.conditions.length
      ? `, conditions: ${st.conditions.join(", ")}`
      : "";
    lines.push(`State changed: HP ${st.currentHp}/${session.character.maxHp}${cond}.`);
  }
  return lines.join("\n");
}

/**
 * STAGE 2 — Narrative: the narrative model writes the scene (streaming),
 * consistent with the mechanical summary. No tools. Appends the narration to
 * the history.
 */
async function runNarrativeStage(
  session: Session,
  mechanical: string,
  emit: (e: StreamEvent) => void,
): Promise<void> {
  const world = loadWorld();
  const lore = loadLore();
  const narrativeSystem: ChatCompletionMessageParam = {
    role: "system",
    content: [
      NARRATIVE_SYSTEM_PROMPT,
      world
        ? `# Setting (player-facing — the surface world the character already knows; you MAY reveal this naturally through play)\n${world}`
        : "",
      lore
        ? `# GM-ONLY SECRETS (NEVER reveal, narrate, quote, or dump these — not even in the opening. They are background only: use them to plant at most one small, deniable hint at a time, and only once the player earns it.)\n${lore}`
        : "",
      characterSheetBlock(session.character),
    ]
      .filter(Boolean)
      .join("\n\n"),
  };

  // The turn's results go in a FINAL user message, not the system prompt:
  // small models follow the most recent context far more reliably, and this is
  // the one block the narration must not contradict. Not persisted to history.
  const resultsMessage: ChatCompletionMessageParam = {
    role: "user",
    content: mechanical
      ? `[GM ENGINE — WHAT ACTUALLY HAPPENED THIS TURN. Narrate EVERY numbered line below, in order, faithfully: never flip a miss into a hit, never omit a blow that landed on the player. These lines are COMPLETE: if the player's message declared an item, attack, or ability that does NOT appear below, it DID NOT HAPPEN — the engine rejected or ignored it (usually the item isn't in their Equipment). Show its absence in-fiction ("your hand finds no such flask in your pack") instead of narrating it working. Don't quote the raw terms or numbers; show them as story.]\n${mechanical}`
      : "[GM ENGINE] No roll was needed and NO mechanical effect happened (no damage, no healing, no item consumed). Resolve the player's declared action plainly and stay in the CURRENT scene — do NOT invent new locations, events, or plot, and do NOT narrate items/abilities taking mechanical effect.",
  };

  const inCombat = session.state.combat?.active === true;
  const stream = await client.chat.completions.create({
    model: NARRATIVE_MODEL,
    messages: [
      narrativeSystem,
      ...session.messages.slice(-NARRATIVE_CONTEXT_MESSAGES),
      resultsMessage,
    ],
    stream: true,
    // Combat narration runs cooler: less creative license = fewer flipped facts.
    temperature: inCombat ? 0.4 : 0.6,
    // Hard length cap so the scene can't ramble (the "1-3 paragraphs" limit in
    // the prompt is a soft ask; this enforces it).
    max_tokens: 450,
    top_p: 0.9,
    ...NO_REASONING,
  });

  let narration = "";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      narration += delta;
      emit({ type: "delta", text: delta });
    }
  }
  session.messages.push({ role: "assistant", content: narration });
}

/**
 * Runs a turn in two stages: (1) the rules model resolves the PF2e mechanics
 * via tools; (2) the narrative model writes the scene consistent with the
 * result, streaming. Emits events via `emit`.
 */
export async function runTurn(
  session: Session,
  playerText: string,
  emit: (e: StreamEvent) => void,
): Promise<void> {
  session.messages.push({ role: "user", content: playerText });
  console.log(
    `[GM] turn started (rules=${RULES_MODEL}, narrative=${NARRATIVE_MODEL})`,
  );
  try {
    emit({ type: "phase", phase: "rules" });
    const mechanical = await runRulesStage(session, emit);
    console.log(`[GM] mechanical summary: ${mechanical.slice(0, 160) || "(empty)"}`);

    emit({ type: "phase", phase: "narrative" });
    await runNarrativeStage(session, mechanical, emit);

    console.log("[GM] turn finished");
    emit({ type: "done" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[GM] turn ERROR:", message);
    emit({ type: "error", message });
  }
}
