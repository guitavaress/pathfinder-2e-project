import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { AttackContext, Character, Combatant, Companion, Weapon } from "@pf2e/shared";
import type { CheckResult, DegreeOfSuccess, GameState } from "@pf2e/shared";
import { degreeOfSuccess, isValidDc, rollCheck } from "../dice/check.js";
import {
  actionLabel,
  activityFrequency,
  activityRequirement,
  costProfileOf,
  creatureRecord,
  homonymsOf,
  itemRecord,
  itemTraits,
  lookupLocalRule,
  multiActionCost,
  namedActivity,
  mentionedAction,
  officialConditions,
  spellRecord,
  type CostProfile,
  type RuleRecord,
  type SpellMechanics,
} from "../rules/dataset.js";
import { lookupWebRule } from "../rules/web.js";
import { scaleParcels, type DamageParcel } from "../rules/damage.js";
import { conditionModifiersFor } from "../rules/condition-modifiers.js";
import { actorDefensesFor, actorModifiersFor } from "../rules/actor-modifiers.js";
import { ModifierStack } from "../rules/modifiers.js";
import { rollOptionsForCheck } from "../rules/roll-context.js";
import {
  anchorToRound,
  effectLabel,
  expireEffects,
  grantEffect,
  mentionedSelfEffect,
  selfEffectOf,
  type ExpiryEvent,
} from "../rules/active-effects.js";
import type { RollOptions } from "../rules/roll-options.js";
import { buildTools } from "./tool-schemas.js";
import {
  allyCombatant,
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
  creatureXp,
  effectiveAC,
  ENCOUNTER_DIFFICULTIES,
  encounterBudget,
  enemyCombatant,
  findCombatant,
  hasCombatantNamed,
  isOffGuard,
  livingEnemy,
  mapPenalty,
  MAX_PARTY_SIZE,
  newCompanion,
  PLAYER_STRIKE_REACTIONS,
  normalizeName,
  setActorDefenseSource,
  setActorModifierSource,
  sheetStack,
  planEncounter,
  playerCombatant,
  playerOf,
  partySizeOf,
  rollDice,
  setConditionModifierSource,
  strikeProfileFrom,
  tickEndOfRound,
  tickPersistentDamage,
  type EncounterDifficulty,
  type EncounterPlan,
  type EnemySpec,
  type StrikeProfile,
} from "./combat.js";
import {
  brainJournal,
  brainKnowledge,
  brainTurnStamp,
  queueBrainWrite,
} from "./brain.js";
import { loadLore, loadWorld } from "./lore.js";
import { pickVoice, voiceDirective } from "./voice-gate.js";
import { saveSession } from "./save.js";
import {
  NARRATIVE_SYSTEM_PROMPT,
  RULES_SYSTEM_PROMPT,
  characterSheetBlock,
} from "./prompts.js";
import type { Session } from "./sessions.js";

/**
 * Liga o DADO oficial como fonte dos modificadores de condição (Fase 2.5 / T4).
 *
 * `combat.ts` é puro e não carrega o dataset; `agent.ts` já carrega. Um ponto
 * de injeção só, no import — nenhum call site de `effectiveAC` pode esquecer, e
 * o núcleo puro continua funcionando (com o fallback embutido) em teste unitário
 * sem `generated/`.
 */
setConditionModifierSource(conditionModifiersFor);
// Mesmo contrato para os modificadores da FICHA (T5.4): quem carrega o dataset
// é `agent.ts`, `combat.ts` segue puro. Sem `ro` aqui de propósito — a
// iniciativa é rolada antes de existir contexto de rolagem, e nesse ponto só
// entram os incondicionais em seletor composto pela engine.
setActorModifierSource((character, selector) => actorModifiersFor(character, selector).applied);
// Defesas tipadas da ficha (T5.5). O contexto é o da FICHA — sem alvo e sem
// item —, que é o que existe quando o combate começa; predicados que dependem
// de efeito ativo ficam de fora, declarados.
setActorDefenseSource(
  (character) => actorDefensesFor(character, rollOptionsForCheck({ character })).defenses,
);

/**
 * As roll options DO PONTO DE VISTA de `self` (Fase 2.5 / T5.2).
 *
 * Em PF2e o rule element mora no ator e o `self:` do predicado é sempre o dono
 * da condição — então a CA do defensor e a rolagem do atacante NÃO podem
 * compartilhar um contexto só. Um Strike monta dois: `(alvo, atacante)` para a
 * CA e `(atacante, alvo)` para o ataque. Trocar os papéis inverteria silen-
 * ciosamente todo predicado que fala de alvo.
 */
function rollOptionsOf(
  session: Session,
  self: Combatant,
  target?: Combatant,
  opts: { action?: string; item?: string; damageType?: string } = {},
): RollOptions {
  return rollOptionsForCheck({
    ...(self.kind === "player" ? { character: session.character } : {}),
    self,
    ...(target ? { target } : {}),
    ...opts,
  });
}

/**
 * Single model that drives both stages by default. Each stage runs its own
 * CONTEXT (system prompt + message thread), not its own model — one set of
 * weights stays resident across the turn instead of being swapped (which on
 * ~12 GB VRAM costs minutes per turn). Gemma 4 12B (Q4) is the default: it fits
 * entirely in ~12 GB VRAM (no CPU offload) and follows instructions well.
 *
 * llama.cpp serves whatever GGUF was loaded at startup and IGNORES the `model`
 * field on requests; this value only feeds the /health check, which matches it
 * against GET /v1/models. Servers that do route by model (LM Studio, Ollama)
 * need it to be the exact key.
 */
const GM_MODEL = process.env.GM_MODEL ?? "gemma-4-12b-it";
/** Model for the RULES/tools stage. Defaults to GM_MODEL; override only to
 * split across two models (needs a second server, one model each). */
export const RULES_MODEL = process.env.RULES_MODEL ?? GM_MODEL;
/** Model for the NARRATIVE stage. Defaults to GM_MODEL; override only to split
 * across two models (needs a second server, one model each). */
export const NARRATIVE_MODEL = process.env.NARRATIVE_MODEL ?? GM_MODEL;
/**
 * The LLM server's OpenAI-compatible base URL (llama.cpp's llama-server by
 * default, on :1234). `LMSTUDIO_BASE_URL` is the pre-2026-07-16 name, still
 * honored so an old .env keeps working.
 *
 * 127.0.0.1 and NOT localhost: llama-server binds IPv4 only unless told
 * otherwise, and on WSL2 `localhost` resolves to IPv6 ::1 first — the same trap
 * that forced the Vite proxy onto a literal IP (packages/web/vite.config.ts).
 */
export const LLM_BASE_URL =
  process.env.LLM_BASE_URL ??
  process.env.LMSTUDIO_BASE_URL ??
  "http://127.0.0.1:1234/v1";
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
 * Acessa um conjunto por-turno criando-o na hora se faltar.
 *
 * `runRulesStage` reseta esses conjuntos a cada turno, mas quem chamasse
 * `executeTool` fora daquele caminho ficava sem eles — e como o código usava
 * `?.add`/`?.has`, o guard de dupla contagem simplesmente NÃO EXISTIA, em
 * silêncio. Guard que pode sumir sem avisar não é guard.
 */
function turnSet(map: WeakMap<Session, Set<string>>, session: Session): Set<string> {
  let set = map.get(session);
  if (!set) {
    set = new Set();
    map.set(session, set);
  }
  return set;
}
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
/** Inimigos (por id) que já conjuraram neste combate — casters gastam a melhor
 *  magia UMA vez por luta (política determinística; o 12B nunca decide). */
const combatEnemyCasts = new WeakMap<Session, Set<string>>();

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
  // A cauda aceita número OU fórmula de dado: a própria engine grava
  // "persistent fire damage 1d4" (agent.ts, tick de fim de rodada) e o guard
  // antigo — `(\s+\d+)?$` — rejeitava isso, então o modelo não conseguia
  // aplicar dano persistente de armadilha no formato que a engine usa.
  if (/^persistent\b.*damage(\s+\d+(d\d+)?([+-]\d+)?)?$/.test(c)) return true;
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

/**
 * Feat DA FICHA citado no texto cujo custo NÃO é ação (reação ou free action).
 *
 * Dirigido pela ficha de propósito: o personagem só usa o que tem, e é a ficha
 * que desempata homônimos entre `feats.json` e `actions.json` (ver
 * `costProfileOf`). Nomes curtos ficam de fora pelo mesmo motivo que em
 * `namedActivity`: falso positivo em prosa livre.
 */
function sheetNonActionIn(session: Session, text: string): CostProfile | null {
  const t = text.toLowerCase();
  for (const featName of session.character.feats) {
    if (featName.length < 6) continue;
    if (!t.includes(featName.toLowerCase())) continue;
    const profile = costProfileOf(featName, "feats");
    if (profile && (profile.kind === "reaction" || profile.kind === "free")) {
      return profile;
    }
  }
  return null;
}

/**
 * Cobra o custo REAL de um feat de reação/free action do jogador.
 *
 * PF2e: reação não sai das 3 ações — ela gasta A reação, uma por rodada,
 * recarregada no início do turno (`beginPlayerRound`). Antes disto a engine
 * não lia `actionType`: reação caía no `clampActionCost` e debitava 1 das 3
 * ações, e a reação do jogador nunca era consumida (só a de inimigo, em
 * `triggerEnemyReactions`) — dava para usar Nimble Dodge a rodada inteira.
 *
 * Retorna o erro quando a reação já foi gasta, ou null quando cobrou.
 */
function chargeNonAction(
  session: Session,
  you: Combatant,
  profile: CostProfile,
  emit: (e: StreamEvent) => void,
): ToolOutcome | null {
  const pretty = titleCase(profile.name);
  if (profile.kind === "free") {
    return null; // free action: não gasta ação nem reação.
  }
  if (!you.reactionAvailable) {
    return {
      content: `ILLEGAL: "${pretty}" is a REACTION and the player already used their reaction this round. It does NOT happen — the reaction refreshes at the start of the next turn.`,
      isError: true,
      summaryLine: `- ${pretty}: NOT used — reaction already spent this round.`,
    };
  }
  you.reactionAvailable = false;
  emit({ type: "state", state: session.state });
  return null;
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
/**
 * Janelas de histórico por estágio. Dimensionadas em 2026-07-16 para o contexto
 * de 64k do llama.cpp (antes eram 6/30, para os 8192 do LM Studio — medido: os
 * dois estágios raspavam o teto).
 *
 * Custo medido nesta máquina: prompt de ~16k faz prefill em ~7s (2200 tok/s), e
 * a janela deslizante invalida o cache de prefixo do llama.cpp a cada turno
 * assim que o histórico passa da janela (a mensagem mais antiga cai e o prefixo
 * muda). Por isso as janelas são generosas mas não gulosas: um 12B também perde
 * qualidade com contexto longo demais ("lost in the middle").
 */
/** Quantas mensagens recentes o rules stage vê. Ele resolve a mecânica DESTE
 * turno; contexto demais só o confunde. ~2,1k tokens. */
const RULES_CONTEXT_TURNS = 16;
/** Quantas mensagens recentes o narrador vê — é o fio da história, e o que mais
 * ataca a sensação de one-shot. ~40 turnos, ~10,5k tokens. */
const NARRATIVE_CONTEXT_MESSAGES = 80;
/** Disables "thinking" on reasoning models (e.g. gemma-4): without it they burn
 * the token budget on `reasoning_content` we never show, starving the visible
 * output (empty narration). Cast because the OpenAI type doesn't list "none".
 * Redundant against a llama-server started with `--reasoning off` (it accepts
 * and ignores the field), but kept so the GM behaves on servers that honor it. */
const NO_REASONING = { reasoning_effort: "none" } as unknown as {
  reasoning_effort: "low";
};

/**
 * Samplers pinned in code, not inherited from whoever serves the model.
 *
 * The server applies its own defaults to anything we omit, and they differ by
 * vendor: llama.cpp ships `repeat_penalty: 1.0` (off) where LM Studio applied
 * ~1.1 — that alone changes how repetitive the narration gets. Doctrine
 * "engine garante" extends here: the GM must behave the same regardless of the
 * backend, and the feat-audit battery's baseline was measured with these on.
 * Values match Gemma's recommended sampling. `top_p` stays per-call (the
 * narrative stage runs tighter than the rules stage).
 *
 * These are llama.cpp/LM Studio extensions to the OpenAI schema, so the cast is
 * the same escape hatch NO_REASONING uses: unknown keys ride along in the JSON
 * body and are ignored by servers that don't implement them.
 */
const SAMPLERS = {
  top_k: 64,
  min_p: 0.05,
  repeat_penalty: 1.1,
} as unknown as Record<never, never>;

/** Events emitted during a turn, forwarded to the client via SSE. */
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "check"; result: CheckResult }
  | { type: "state"; state: GameState }
  | { type: "phase"; phase: "rules" | "narrative" }
  | { type: "done" }
  | { type: "error"; message: string };

// Local servers ignore the API key, but the OpenAI SDK requires a non-empty one.
const client = new OpenAI({ baseURL: LLM_BASE_URL, apiKey: "local" });

/**
 * Declarações de tool mandadas ao modelo, DERIVADAS do registro de schemas.
 *
 * `tool-schemas.ts` é a fonte única: descrição e contrato de argumentos moram
 * lá, e o JSON Schema daqui é gerado do zod — era a duplicação entre literal e
 * validação que deixava `roll_damage` (tool inexistente) prometida ao modelo em
 * duas descrições, e `damageType` lido sem nunca ter sido declarado.
 */
const TOOLS: ChatCompletionTool[] = buildTools();

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

/**
 * Os seletores do DADO para uma rolagem nomeada na ficha (Fase 2.5 / T5.4).
 *
 * O pf2e nomeia a mesma rolagem em dois níveis: um save de Vontade é
 * `saving-throw` E `will`, uma perícia é `skill-check` E `stealth`. Rule
 * elements usam os dois — pedir só um perderia metade.
 */
function checkSelectors(session: Session, skillRaw: string): string[] {
  const key = skillRaw.toLowerCase().trim();
  const c = session.character;
  if (key === "perception") return ["perception"];
  if (key === "fortitude" || key === "fort") return ["saving-throw", "fortitude"];
  if (key === "reflex" || key === "ref") return ["saving-throw", "reflex"];
  if (key === "will") return ["saving-throw", "will"];
  if (c.skills[key]) return ["skill-check", key];
  if (c.lores.some((l) => l.name.toLowerCase() === key || key.includes(l.name.toLowerCase()))) {
    // Lore tem nome livre; o dado não tem seletor por lore específica.
    return ["skill-check"];
  }
  if (findSheetWeapon(c, key)) return ["attack", "attack-roll"];
  return [];
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

/** Attack bonus for a Strike: the player's weapon bonus, or the enemy's real/benchmark attack. */
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
  return strikeProfileFor(attacker).bonus;
}

const DAMAGE_TYPE_NAMES: Record<string, string> = {
  P: "piercing",
  S: "slashing",
  B: "bludgeoning",
};

/** Parses the faces of a die string like "d6" → 6 (defaults to 6). */
export function parseDie(die: string): number {
  const m = /d(\d+)/i.exec(die);
  return m ? Number(m[1]) : 6;
}

/** Rolls a formula like "2d6+3" (single dice group + optional flat bonus). */
export function rollFormula(formula: string): number {
  let total = 0;
  const dice = /(\d+)\s*d\s*(\d+)/i.exec(formula);
  if (dice) total += rollDice(Number(dice[1]), Number(dice[2]));
  const flat = /d\s*\d+\s*([+-]\s*\d+)/i.exec(formula);
  if (flat) total += Number(flat[1]!.replace(/\s+/g, ""));
  return Math.max(0, total);
}

/**
 * Rolls Strike damage for the active attacker against a target.
 *
 * Devolve também as PARCELAS tipadas: um Strike de statblock pode ser
 * "1d8 piercing + 1d6 fire", e colapsar isso num tipo só apagaria a fraqueza a
 * fogo do alvo. `type` segue existindo para o texto do resumo.
 */
function rollDamage(
  session: Session,
  attacker: Combatant | undefined,
  input: Record<string, unknown>,
): { amount: number; type: string; parcels: DamageParcel[] } {
  const crit = input.crit === true || input.degree === "criticalSuccess";
  const dbl = (n: number) => (crit ? n * 2 : n);
  const one = (amount: number, type: string) => ({
    amount,
    type,
    parcels: [{ amount, type }],
  });

  const formula = input.formula ? String(input.formula) : "";
  if (formula) {
    const type = input.damageType ? String(input.damageType) : "damage";
    return one(dbl(rollFormula(formula)), type);
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
      return one(amount, type);
    }
  }

  // Inimigo (ou fallback): statblock real quando houver, senão benchmark —
  // strikeProfileFor decide. Soma todas as entradas de dano do ataque.
  const profile = attacker
    ? strikeProfileFor(attacker)
    : strikeProfileFrom(undefined, 0);
  // Tipo forçado pela tool colapsa as parcelas (o modelo declarou UM tipo);
  // sem ele, cada entrada do statblock vira parcela própria.
  const forced = input.damageType ? String(input.damageType) : null;
  const rolled = profile.damage.map((d) => ({
    amount: dbl(rollFormula(d.formula)),
    type: forced ?? d.type,
  }));
  const amount = rolled.reduce((sum, d) => sum + d.amount, 0);
  const type = forced ?? profile.damage[0]?.type ?? "damage";
  return { amount, type, parcels: rolled.length > 0 ? rolled : [{ amount, type }] };
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

/**
 * Resolves a creature by name against the bestiary (statblock records only —
 * a same-named feat/spell can never stat an enemy). Returns the record plus
 * the level to use (record's official level, else the low default).
 */
function resolveCreature(name: string): { record: RuleRecord | null; level: number } {
  const record = creatureRecord(name);
  if (record && typeof record.level === "number") {
    return { record, level: record.level };
  }
  return { record: null, level: DEFAULT_ENEMY_LEVEL };
}

/** Roster de companheiros da sessão (inicializa o campo em saves antigos). */
function companionsOf(session: Session): Companion[] {
  return (session.state.companions ??= []);
}

/** Tudo que a ficha nomeia e pode disparar um efeito auto-dirigido. */
function ownedAbilities(session: Session): string[] {
  const c = session.character;
  return [...(c.feats ?? []), ...(c.classFeatures ?? [])];
}

/**
 * Põe no registro o efeito que a ficha autoriza, devolvendo a linha do resumo.
 *
 * O efeito precisa existir no dado E estar na ficha: nome inventado não entra,
 * e ability que o personagem não tem não concede nada. Reaplicar repõe a
 * duração em vez de empilhar.
 */
function grantPlayerEffect(session: Session, ref: string, source: string): string | null {
  const round = session.state.combat?.active ? session.state.combat.round : null;
  const { effects, granted, refreshed } = grantEffect(
    session.state.effects ?? [],
    ref,
    source,
    round,
  );
  if (!granted) return null;
  session.state.effects = effects;
  return `- ${refreshed ? "Renewed" : "Now in effect"}: ${effectLabel(granted)}.`;
}

/**
 * Expira os efeitos vencidos num dos três limites de tempo da engine e devolve
 * as linhas do resumo mecânico.
 *
 * Efeito que não expira é pior do que efeito que não existe: vira bônus
 * permanente inventado, e o narrador passa a descrever um personagem enfurecido
 * três cenas depois. Por isso o tick é da engine, nunca do modelo.
 */
function expirePlayerEffects(session: Session, event: ExpiryEvent): string[] {
  const list = session.state.effects;
  if (!list?.length) return [];
  const { effects, expired } = expireEffects(list, event, session.state.combat?.round ?? null);
  if (expired.length === 0) return [];
  session.state.effects = effects;
  return expired.map((e) => `- Effect ends: ${effectLabel(e)}.`);
}

/** Companheiro do roster cujo nome bate (fuzzy, mesmos dois sentidos do combate). */
function findCompanion(session: Session, ref: string): Companion | undefined {
  const key = normalizeName(ref);
  if (!key) return undefined;
  return companionsOf(session).find((c) => {
    const n = normalizeName(c.name);
    return n.length > 0 && (n === key || n.includes(key) || key.includes(n));
  });
}

/**
 * Copia HP/condições dos combatentes ally de volta ao roster (mesmo id).
 * Rodada a cada turno: ferida em combate persiste fora dele — o roster e o
 * combate nunca contam histórias diferentes sobre o mesmo companheiro.
 */
export function syncCompanions(session: Session): void {
  const combat = session.state.combat;
  if (!combat) return;
  for (const comp of companionsOf(session)) {
    const inCombat = combat.combatants.find(
      (c) => c.kind === "ally" && c.id === comp.id,
    );
    if (!inCombat) continue;
    comp.currentHp = inCombat.currentHp;
    comp.conditions = [...inCombat.conditions];
  }
}

/**
 * The strike an enemy combatant uses, re-resolved from the bestiary via its
 * stable `sourceName` (real attack name/bonus/damage/agile), else benchmark.
 */
function strikeProfileFor(c: Combatant): StrikeProfile {
  const rec = c.sourceName ? creatureRecord(c.sourceName) : null;
  return strikeProfileFrom(rec?.statblock, c.level ?? 0);
}

/**
 * Custo em ações de uma conjuração a partir do time.value cru do dataset:
 * "2" → 2; "1 to 3" → 2 (meio-termo do Heal); "reaction"/"free" → 0;
 * "1 minute"+ → 3 (turno inteiro; fora de combate é só narrativa).
 */
function castActionCost(raw: string | undefined): number {
  const s = (raw ?? "").toLowerCase().trim();
  if (!s) return 2;
  if (/reaction|free/.test(s)) return 0;
  if (/minute|hour|day/.test(s)) return 3;
  const m = /^(\d)/.exec(s);
  if (m) return Math.max(1, Math.min(3, Number(m[1])));
  return 2;
}

/**
 * Rola o dano/cura de uma magia no rank de conjuração: fórmula base + os
 * passos de heightening ("+2d6 por rank" do Fireball, "+1d4" do cantrip).
 */
function rollSpellDamage(
  mech: SpellMechanics,
  castRank: number,
): { total: number; type: string; parcels: DamageParcel[] } {
  const steps = mech.heighten
    ? Math.max(0, Math.floor((castRank - mech.rank) / mech.heighten.interval))
    : 0;
  let total = 0;
  let type = "";
  // Cada entrada de dano da magia vira parcela própria: magia de dois tipos
  // (ex.: fogo + som) precisa ser medida contra as defesas de CADA tipo.
  const parcels: DamageParcel[] = [];
  mech.damage.forEach((d, i) => {
    let amount = rollFormula(d.formula);
    const add = mech.heighten?.add[i];
    if (add) for (let s = 0; s < steps; s++) amount += rollFormula(add);
    total += amount;
    parcels.push({ amount, type: d.type });
    if (!type && d.type && d.type !== "untyped") type = d.type;
  });
  return { total, type, parcels };
}

/** Devolve o slot/focus cobrado quando a conjuração acabou rejeitada. */
function refundSpellResource(
  session: Session,
  isCantrip: boolean,
  isFocus: boolean,
  castRank: number,
): void {
  if (isCantrip) return;
  if (isFocus) {
    const used = session.state.focusPointsUsed ?? 0;
    session.state.focusPointsUsed = Math.max(0, used - 1);
    return;
  }
  const rankKey = String(castRank);
  const used = session.state.spellSlotsUsed?.[rankKey] ?? 0;
  session.state.spellSlotsUsed = {
    ...(session.state.spellSlotsUsed ?? {}),
    [rankKey]: Math.max(0, used - 1),
  };
}

/** Difficulty declared by the model; anything unrecognized falls back to "moderate". */
function parseDifficulty(v: unknown): EncounterDifficulty {
  const s = String(v ?? "").toLowerCase().trim();
  return (ENCOUNTER_DIFFICULTIES as readonly string[]).includes(s)
    ? (s as EncounterDifficulty)
    : "moderate";
}

/** Budget-cut annotations for the mechanical summary (audit trail). */
function budgetNotes(plan: EncounterPlan): string {
  const parts: string[] = [];
  if (plan.trimmedOver.length) {
    const cut = plan.trimmedOver.map((s) => `${s.count}× ${s.name}`).join(", ");
    parts.push(`[budget: dropped ${cut} — over ${plan.requested} ${plan.budget} XP for this party]`);
  }
  if (plan.droppedForbidden.length) {
    const cut = plan.droppedForbidden
      .map((s) => `${s.name} (level ${s.level} > party level +4)`)
      .join(", ");
    parts.push(`[forbidden: ${cut}]`);
  }
  if (plan.downleveled) {
    parts.push(
      `[budget: ${plan.downleveled.name} weakened from level ${plan.downleveled.from} to ${plan.downleveled.to} to fit]`,
    );
  }
  return parts.length ? ` ${parts.join(" ")}` : "";
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
        const chargedSet = turnSet(turnActivityCharged, session);
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
        const weaponName = findSheetWeapon(session.character, skill)?.name ?? skill;
        const ac = effectiveAC(target, rollOptionsOf(session, target, attacker, { action: "Strike" }));
        const statusPen = attackStatusPenalty(
          attacker,
          rollOptionsOf(session, attacker, target, { action: "Strike", item: weaponName }),
        );
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
        let dmg: { amount: number; type: string; parcels: DamageParcel[] } | null = null;
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
              // Parcela PRÓPRIA: dano de precisão tem o tipo da arma, mas 464
              // criaturas são imunes a precisão — só a parcela cai, não o golpe.
              dmg.parcels.push({ amount: sneak, type: dmg.type, category: "precision" });
            }
          }
          const before = target.currentHp;
          const adj = applyDamage(target, dmg.parcels);
          turnSet(turnStruck, session).add(target.id);
          if (target.kind === "player") session.state.currentHp = target.currentHp;
          let defeatedNote = target.defeated ? ` — ${target.name} DEFEATED` : "";
          if (target.kind === "player" && target.defeated) {
            defeatedNote = ` — ${enterDying(session, crit)}`;
          }
          damageLine = ` for ${dmg.amount} ${dmg.type}${adj.note}; ${target.name} ${before}→${target.currentHp} HP${defeatedNote}`;
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
      // Reação/free da ficha citada no reason: o custo dela não é ação, então
      // a base cai para 0 e a reação é debitada abaixo.
      const checkNonAction = combat?.active
        ? sheetNonActionIn(session, `${reason} ${skill}`)
        : null;
      const skillBase = checkNonAction
        ? 0
        : clampActionCost(input.actions, isSave ? 0 : 1);
      const skillActivity =
        combat?.active && !checkNonAction ? multiActionCost(`${reason} ${skill}`) : null;
      const skillCharged = turnSet(turnActivityCharged, session);
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
      if (checkNonAction && combat?.active) {
        const you = playerOf(combat);
        if (you && !you.defeated) {
          const blocked = chargeNonAction(session, you, checkNonAction, emit);
          if (blocked) return blocked;
        }
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
      // Modificadores vindos do DADO (T5.4): condições do jogador (frightened
      // penaliza TODA checagem, não só ataque — a engine ignorava isso fora do
      // combate) e os FlatModifier situacionais dos feats da ficha.
      const selectors = checkSelectors(session, skill);
      const you = combat?.active ? playerOf(combat) : undefined;
      const checkRo = rollOptionsForCheck({
        character: session.character,
        ...(you ? { self: you } : {}),
        selfConditions: session.state.conditions,
        ...(() => {
          const named = mentionedAction(`${reason} ${skill}`);
          return named ? { action: named } : {};
        })(),
      });
      const conditions = you?.conditions ?? session.state.conditions;
      const stack = new ModifierStack()
        .addAll(selectors.length ? conditionModifiersFor(conditions, selectors, checkRo) : [])
        .addAll(
          selectors.length
            ? actorModifiersFor(session.character, selectors, checkRo).applied
            : [],
        );
      // O "porquê" acompanha o número: `checkReason` corta no primeiro " (",
      // então isto enriquece a UI sem mexer no resumo mecânico nem nas linhas
      // que a bateria raspa.
      const why = stack.total() ? ` [${stack.breakdown()}]` : "";
      const result = rollCheck(
        `${reason} (${skill} vs DC ${dc})${why}`,
        modifier + stack.total(),
        dc,
      );
      emit({ type: "check", result });
      return {
        content: JSON.stringify(result),
        summaryLine: `- ${checkReason(result.label)}: ${DEGREE_EN[result.degree]}.`,
      };
    }
    case "rest": {
      const kind = String(input.kind ?? "").toLowerCase().trim();
      const combat = session.state.combat;
      if (combat?.active) {
        return {
          content:
            "ILLEGAL: cannot rest during combat. Resolve or leave the fight first (end_combat when the story moves past it).",
          isError: true,
        };
      }
      const c = session.character;

      if (kind === "overnight") {
        // RAW: descanso noturno cura CON (mín. 1) × nível; prepara magias de
        // novo (slots/focus); remove fatigued; drained/doomed caem 1 por dia.
        const conMod = c.abilityModifiers.con;
        const heal = Math.max(1, conMod) * c.level;
        const before = session.state.currentHp;
        session.state.currentHp = Math.min(c.maxHp, before + heal);
        session.state.spellSlotsUsed = undefined;
        session.state.focusPointsUsed = undefined;
        let conds = session.state.conditions.filter((x) => !/^fatigued$/i.test(x));
        const drained = conditionValueIn(conds, "drained");
        if (drained > 0) conds = setValuedCondition(conds, "drained", drained - 1);
        const doomed = conditionValueIn(conds, "doomed");
        if (doomed > 0) conds = setValuedCondition(conds, "doomed", doomed - 1);
        session.state.conditions = conds;
        // Oito horas passam: só efeito SEM prazo atravessa a noite.
        const ended = expirePlayerEffects(session, "rest");
        emit({ type: "state", state: session.state });
        const gained = session.state.currentHp - before;
        const slotsNote = c.spellcasting.length ? " Spell slots and focus points restored." : "";
        return {
          content: `Overnight rest (8h): healed ${gained} HP (CON ${conMod >= 0 ? "+" : ""}${conMod} × level ${c.level}): ${before}→${session.state.currentHp}/${c.maxHp}.${slotsNote} Fatigued removed; drained/doomed reduced by 1. A full night passes in the story.`,
          summaryLine: `- A full night's rest: ${session.character.name} recovers ${gained} HP (${before}→${session.state.currentHp}) and wakes with renewed strength. The night passes.${ended.length ? ` ${ended.length} effect(s) wear off overnight.` : ""}`,
        };
      }

      if (kind === "treat_wounds") {
        // RAW: Medicine treinado + healer's toolkit; DC 15 → 2d8 (crit 4d8),
        // crit falha causa 1d8. Sem relógio de jogo, o custo de tempo (10 min
        // + 1h de imunidade) vai para a narração.
        const med = c.skills["medicine"];
        if (!med || med.rank < 1) {
          return {
            content: `REJECTED: Treat Wounds requires TRAINED Medicine — ${c.name} is untrained. No HP recovered. Overnight rest ('overnight') is the alternative.`,
            isError: true,
            summaryLine: `- Treat Wounds: FAILED — ${c.name} lacks the medical training.`,
          };
        }
        const toolkit = c.equipment.some((e) => /healer'?s (toolkit|kit|tools)/i.test(e.name));
        if (!toolkit) {
          return {
            content: `REJECTED: Treat Wounds requires a healer's toolkit and there is none in the Equipment. No HP recovered. Overnight rest ('overnight') is the alternative.`,
            isError: true,
            summaryLine: `- Treat Wounds: FAILED — no healer's toolkit in the pack.`,
          };
        }
        const result = rollCheck(`Treat Wounds: Medicine check (DC 15)`, med.modifier, 15);
        emit({ type: "check", result });
        const before = session.state.currentHp;
        let note: string;
        if (result.degree === "criticalSuccess") {
          const heal = rollDice(4, 8);
          session.state.currentHp = Math.min(c.maxHp, before + heal);
          note = `expert work: recovers ${session.state.currentHp - before} HP (${before}→${session.state.currentHp})`;
        } else if (result.degree === "success") {
          const heal = rollDice(2, 8);
          session.state.currentHp = Math.min(c.maxHp, before + heal);
          note = `recovers ${session.state.currentHp - before} HP (${before}→${session.state.currentHp})`;
        } else if (result.degree === "criticalFailure") {
          const dmg = rollDice(1, 8);
          session.state.currentHp = Math.max(0, before - dmg);
          note = `botched treatment: takes ${dmg} damage (${before}→${session.state.currentHp})`;
        } else {
          note = "the wounds resist treatment; no HP recovered";
        }
        emit({ type: "state", state: session.state });
        return {
          content: `Treat Wounds (${DEGREE_EN[result.degree]}): ${note}. Ten minutes pass; these wounds can only be treated again after an hour of story time.`,
          summaryLine: `- Treat Wounds (ten careful minutes): ${note}.`,
        };
      }

      return {
        content: `Unknown rest kind "${kind}". Use 'overnight' (night's sleep) or 'treat_wounds' (10-minute Medicine treatment).`,
        isError: true,
      };
    }
    case "cast_spell": {
      const spellInput = String(input.spell ?? "").trim();
      if (!spellInput) {
        return { content: "Missing 'spell': pass the spell's name.", isError: true };
      }
      const c = session.character;

      // Grounding: a magia PRECISA estar na ficha (nome exato → contido).
      const key = spellInput.toLowerCase();
      let entry = c.spellcasting.find((e) =>
        e.spells.some((s) => s.toLowerCase() === key),
      );
      let sheetName = entry?.spells.find((s) => s.toLowerCase() === key);
      if (!entry) {
        for (const e of c.spellcasting) {
          const m = e.spells.find(
            (s) => s.toLowerCase().includes(key) || key.includes(s.toLowerCase()),
          );
          if (m) {
            entry = e;
            sheetName = m;
            break;
          }
        }
      }
      if (!entry || !sheetName) {
        const known =
          c.spellcasting.flatMap((e) => e.spells).join(", ") || "none — not a caster";
        return {
          content: `REJECTED: "${spellInput}" is not on the character's sheet (known spells: ${known}). Nothing is cast and nothing is spent.`,
          isError: true,
          summaryLine: `- Cast ${spellInput}: FAILED — not a spell they know.`,
        };
      }

      const mech = spellRecord(sheetName)?.spell;
      // Rank na ficha (spellsByRank) manda; senão o rank base do dataset.
      let sheetRank: number | null = null;
      if (entry.spellsByRank) {
        for (const [rank, list] of Object.entries(entry.spellsByRank)) {
          if (list.some((s) => s.toLowerCase() === sheetName!.toLowerCase())) {
            sheetRank = Number(rank);
            break;
          }
        }
      }
      const baseRank = mech?.rank ?? sheetRank ?? 1;
      const isCantrip = mech?.cantrip === true || sheetRank === 0;
      const isFocus = entry.type.toLowerCase().includes("focus");

      // Cantrips auto-heighten para metade do nível (arredondado para cima).
      let castRank = isCantrip ? Math.ceil(c.level / 2) : baseRank;
      if (!isCantrip && input.rank != null && Number.isFinite(Number(input.rank))) {
        castRank = Math.max(baseRank, Math.min(10, Math.round(Number(input.rank))));
      }

      // Slot/focus: a engine cobra o recurso REAL (sem dado de slots na ficha
      // antiga, cobra às cegas mas não bloqueia — ausência honesta).
      let resourceNote = "";
      if (isCantrip) {
        resourceNote = " (cantrip, no slot)";
      } else if (isFocus) {
        const max = c.focusPoints ?? 0;
        const used = session.state.focusPointsUsed ?? 0;
        if (max > 0 && used >= max) {
          return {
            content: `REJECTED: no Focus Points left (${used}/${max} spent — Refocus restores 1). The spell is NOT cast.`,
            isError: true,
            summaryLine: `- Cast ${sheetName}: FAILED — no focus left.`,
          };
        }
        session.state.focusPointsUsed = used + 1;
        resourceNote = max > 0 ? ` (focus ${used + 1}/${max})` : " (focus)";
      } else {
        const rankKey = String(castRank);
        const slotsMax = entry.slots?.[rankKey];
        const used = session.state.spellSlotsUsed?.[rankKey] ?? 0;
        if (slotsMax != null && used >= slotsMax) {
          const left = Object.entries(entry.slots ?? {})
            .map(([r, max]) => {
              const u = session.state.spellSlotsUsed?.[r] ?? 0;
              return max - u > 0 ? `rank ${r}: ${max - u}` : "";
            })
            .filter(Boolean)
            .join(", ");
          return {
            content: `REJECTED: no rank-${castRank} spell slots left (${used}/${slotsMax} spent today). Slots remaining: ${left || "none"}. The spell is NOT cast.`,
            isError: true,
            summaryLine: `- Cast ${sheetName}: FAILED — no rank-${castRank} slots left.`,
          };
        }
        session.state.spellSlotsUsed = {
          ...(session.state.spellSlotsUsed ?? {}),
          [rankKey]: used + 1,
        };
        resourceNote =
          slotsMax != null
            ? ` (slot ${used + 1}/${slotsMax} rank ${castRank})`
            : ` (rank ${castRank} slot)`;
      }

      // Custo de ações em combate (fora de combate não conta).
      const combat = session.state.combat;
      const you = combat?.active ? playerOf(combat) : null;
      const inCombat = !!you && !you.defeated;
      const cost = castActionCost(mech?.castActions);
      if (inCombat && you!.actionsRemaining < cost) {
        // Recurso NÃO pode ficar cobrado numa conjuração ilegal — devolve.
        refundSpellResource(session, isCantrip, isFocus, castRank);
        return {
          content: `ILLEGAL: casting ${sheetName} costs ${cost} action(s) but the player has only ${you!.actionsRemaining} left this turn. It does NOT happen (the slot was not spent).`,
          isError: true,
          summaryLine: `- Cast ${sheetName}: NOT done — costs ${cost}, only ${you!.actionsRemaining} action(s) left.`,
        };
      }
      if (inCombat) you!.actionsRemaining -= cost;

      const castLabel = `${sheetName}${castRank > baseRank || isCantrip ? ` (rank ${castRank})` : ""}`;

      // Magia BENIGNA com effect homônimo põe o efeito em quem conjurou, com a
      // duração do dado (Fase 2.6). `selfEffectOf` já barra as 63 hostis — o
      // efeito de Ill Omen incide em quem foi atingido, nunca no conjurador —,
      // e um alvo inimigo explícito barra o resto.
      const castRec = spellRecord(sheetName);
      const spellTargetRef = String(input.target ?? "").trim();
      const spellTargetFoe =
        session.state.combat?.active && spellTargetRef
          ? findCombatant(session.state.combat, spellTargetRef)?.kind === "enemy"
          : false;
      const castSelfEffect = castRec && !spellTargetFoe ? selfEffectOf(castRec) : null;
      const castEffLine = castSelfEffect
        ? grantPlayerEffect(session, castSelfEffect.name, sheetName)
        : null;

      // Sem mecânica estruturada: gasto real + efeito narrado (utility spells).
      if (!mech || (mech.damage.length === 0 && !mech.attack && !mech.defense)) {
        emit({ type: "state", state: session.state });
        return {
          content: `${sheetName} is cast${resourceNote}. No structured combat effect — narrate its utility effect faithfully (text: ${spellRecord(sheetName)?.text.slice(0, 300) ?? "see rules"}).`,
          summaryLine: `- Casts ${castLabel}${resourceNote}.${castEffLine ? `\n${castEffLine}` : ""}`,
        };
      }

      const parts: string[] = [];

      // CURA (kinds inclui "healing") sem alvo inimigo → cura o personagem.
      const isHealing = mech.damage.some((d) => d.kinds.includes("healing"));
      const targetRef = String(input.target ?? "").trim();
      const enemyTarget =
        inCombat && targetRef ? findCombatant(combat!, targetRef) : null;
      if (isHealing && (!enemyTarget || enemyTarget.kind !== "enemy")) {
        const amount = rollSpellDamage(mech, castRank);
        const before = session.state.currentHp;
        session.state.currentHp = Math.min(c.maxHp, before + amount.total);
        if (you) you.currentHp = session.state.currentHp;
        emit({ type: "state", state: session.state });
        return {
          content: `${sheetName} heals ${amount.total} HP${resourceNote}: ${before}→${session.state.currentHp}/${c.maxHp}.`,
          summaryLine: `- Casts ${castLabel}${resourceNote}: heals ${amount.total} (${before}→${session.state.currentHp} HP).${castEffLine ? `\n${castEffLine}` : ""}`,
        };
      }

      if (!inCombat) {
        emit({ type: "state", state: session.state });
        return {
          content: `${sheetName} is cast${resourceNote} (no combat active — narrate the effect).`,
          summaryLine: `- Casts ${castLabel}${resourceNote}.${castEffLine ? `\n${castEffLine}` : ""}`,
        };
      }

      // ATAQUE de magia: rola contra a AC real do alvo, com MAP (é um ataque).
      if (mech.attack) {
        const target = enemyTarget;
        if (!target || target.kind !== "enemy" || target.defeated) {
          refundSpellResource(session, isCantrip, isFocus, castRank);
          if (you) you.actionsRemaining += cost;
          return {
            content: `Missing/invalid 'target' for the attack spell ${sheetName} (nothing was spent). Pass the enemy's id or name.`,
            isError: true,
          };
        }
        const map = mapPenalty(you!.mapProgress);
        const ac = effectiveAC(target, rollOptionsOf(session, target, you!, { action: sheetName }));
        const result = rollCheck(
          `${sheetName} spell attack: ${c.name} vs ${target.name} (AC ${ac}${map ? `, MAP ${map}` : ""})`,
          (entry.attack ?? 0) + map,
          ac,
        );
        you!.mapProgress += 1;
        const crit = result.degree === "criticalSuccess";
        const hit = crit || result.degree === "success";
        let dmgNote = "";
        if (hit) {
          const dmg = rollSpellDamage(mech, castRank);
          const amount = crit ? dmg.total * 2 : dmg.total;
          const before = target.currentHp;
          const adj = applyDamage(target, scaleParcels(dmg.parcels, amount));
          dmgNote = ` for ${amount} ${dmg.type || "damage"}${adj.note}; ${target.name} ${before}→${target.currentHp} HP${target.defeated ? " — DOWN" : ""}`;
        }
        result.attack = {
          attacker: c.name,
          target: target.name,
          attackerKind: "player",
          outcome: crit ? "criticalHit" : hit ? "hit" : "miss",
          damage: hit ? null : null,
          damageType: mech.damage[0]?.type ?? null,
        };
        emit({ type: "check", result });
        parts.push(
          `${crit ? "CRITICAL HIT" : hit ? "HIT" : "MISS"}${dmgNote}`,
        );
      } else if (mech.defense?.save) {
        // SAVE: cada alvo rola o save REAL (bestiary) contra o spell DC.
        if (entry.dc == null) {
          refundSpellResource(session, isCantrip, isFocus, castRank);
          if (you) you.actionsRemaining += cost;
          return {
            content: `REJECTED: the sheet has no spell DC for ${entry.name} — cannot resolve ${sheetName} (nothing was spent).`,
            isError: true,
          };
        }
        const targets =
          enemyTarget && enemyTarget.kind === "enemy" && !enemyTarget.defeated
            ? [enemyTarget]
            : mech.area
              ? combat!.combatants.filter((x) => x.kind === "enemy" && !x.defeated)
              : [];
        if (targets.length === 0) {
          refundSpellResource(session, isCantrip, isFocus, castRank);
          if (you) you.actionsRemaining += cost;
          return {
            content: `Missing/invalid 'target' for ${sheetName} (nothing was spent). Pass the enemy's id or name${mech.area ? ", or none to hit every enemy in the area" : ""}.`,
            isError: true,
          };
        }
        const saveKey = mech.defense.save as "fortitude" | "reflex" | "will";
        for (const target of targets) {
          // Save real do statblock; sem statblock, aproximação por nível
          // (percepção do benchmark) — visível no label para auditoria.
          const saveMod =
            target.saves?.[saveKey] ?? benchmark(target.level ?? 0).perception;
          const approx = target.saves ? "" : " approx";
          const result = rollCheck(
            `${sheetName}: ${target.name} ${saveKey}${approx} save vs ${c.name}'s spell DC ${entry.dc}`,
            saveMod,
            entry.dc,
          );
          emit({ type: "check", result });
          const dmg = rollSpellDamage(mech, castRank);
          const mult =
            result.degree === "criticalFailure"
              ? 2
              : result.degree === "failure"
                ? 1
                : result.degree === "success" && mech.defense.basic
                  ? 0.5
                  : 0;
          const amount = Math.floor(dmg.total * mult);
          if (amount > 0) {
            const before = target.currentHp;
            const adj = applyDamage(target, scaleParcels(dmg.parcels, amount));
            parts.push(
              `${target.name} ${DEGREE_EN[result.degree]} → takes ${amount} ${dmg.type || "damage"}${adj.note} (${before}→${target.currentHp} HP${target.defeated ? " — DOWN" : ""})`,
            );
          } else {
            parts.push(`${target.name} ${DEGREE_EN[result.degree]} → unharmed`);
          }
        }
      }

      // Auto-close no wipe (mesmo padrão do Strike).
      let endNote = "";
      if (combat!.active && combatStatus(combat!) !== "ongoing") {
        combat!.active = false;
        endNote =
          combatStatus(combat!) === "victory"
            ? " Combat ends: VICTORY."
            : " Combat ends: DEFEAT.";
      }
      emit({ type: "state", state: session.state });
      return {
        content: `${castLabel} cast${resourceNote} (${cost} action${cost > 1 ? "s" : ""}): ${parts.join("; ")}.${endNote} Actions left: ${you!.actionsRemaining}.`,
        summaryLine: `- Casts ${castLabel}${resourceNote}: ${parts.join("; ")}.${endNote}`,
      };
    }
    case "start_combat": {
      const raw = Array.isArray(input.enemies) ? input.enemies : [];
      const specs: EnemySpec[] = [];
      const recordsBySpecName = new Map<string, RuleRecord>();
      const levelOverrides: string[] = [];
      for (const e of raw as Record<string, unknown>[]) {
        // Escape debris from the model's broken JSON (`Scavenger\" (Thug)`)
        // must not leak into combatant names — it also breaks dedupe.
        const eName =
          String(e?.name ?? "Enemy")
            .replace(/[\\"]/g, "")
            .replace(/\s+/g, " ")
            .trim() || "Enemy";
        const rawCount = Number(e?.count ?? 1);
        const count = Number.isFinite(rawCount) ? Math.max(1, Math.min(8, rawCount)) : 1;
        // Regras como dados: quando o bestiary conhece a criatura, o nível
        // OFICIAL vence o palpite do modelo (e os stats virão do statblock).
        const resolved = resolveCreature(eName);
        const rawLevel = Number(e?.level);
        const modelLevel =
          e?.level != null && Number.isFinite(rawLevel) ? rawLevel : null;
        let level: number;
        if (resolved.record) {
          level = resolved.level;
          recordsBySpecName.set(eName, resolved.record);
          if (modelLevel != null && modelLevel !== level) {
            levelOverrides.push(
              `${resolved.record.name} is level ${level} (bestiary) — model said ${modelLevel}`,
            );
          }
        } else {
          level = modelLevel ?? DEFAULT_ENEMY_LEVEL;
        }
        specs.push({ name: eName, level, count });
      }
      const difficulty = parseDifficulty(input.difficulty);
      const partyLevel = session.character.level;
      const instantiate = (accepted: EnemySpec[]): Combatant[] => {
        const out: Combatant[] = [];
        for (const s of accepted) {
          const record = recordsBySpecName.get(s.name);
          // Statblock real só quando o nível aceito É o oficial: se o orçamento
          // de XP rebaixou a criatura (anti-empty), stats reais mentiriam.
          const sb =
            record?.statblock && record.level === s.level
              ? {
                  ...record.statblock,
                  sourceName: record.name,
                  traits: record.traits ?? [],
                }
              : undefined;
          for (let i = 0; i < s.count; i++) {
            out.push(
              enemyCombatant(s.count > 1 ? `${s.name} ${i + 1}` : s.name, s.level, sb),
            );
          }
        }
        return out;
      };
      const bestiaryNote = levelOverrides.length
        ? ` [${levelOverrides.join("; ")}]`
        : "";

      // Combat already running: do NOT restart (that would wipe HP/initiative).
      // Instead let genuinely new foes join as reinforcements.
      const existing = session.state.combat;
      if (existing?.active) {
        // Dedupe FIRST (fuzzy) so a re-issued start_combat with a slightly
        // different name can't spawn a duplicate NOR spend encounter budget.
        const novel = specs.filter((s) => !hasCombatantNamed(existing, s.name));
        const partySize = partySizeOf(existing.combatants);
        // One encounter, one budget: DEFEATED enemies still count, so the
        // model can't escalate the same fight in endless waves.
        let existingXp = 0;
        for (const c of existing.combatants) {
          if (c.kind !== "enemy") continue;
          existingXp += creatureXp(c.level ?? DEFAULT_ENEMY_LEVEL, partyLevel) ?? 0;
        }
        const plan = planEncounter(novel, existingXp, { partyLevel, partySize, difficulty });
        const added = instantiate(plan.accepted);
        if (added.length) {
          existing.combatants.push(...added);
          existing.combatants.sort((a, b) => b.initiative - a.initiative);
          emit({ type: "state", state: session.state });
          const names = added.map((c) => c.name).join(", ");
          const note = `Encounter now: ${plan.classified} (${plan.totalXp}/${encounterBudget(plan.classified, partySize)} XP).`;
          return {
            content: `Combat already active; reinforcements joined: ${names}. ${note}${budgetNotes(plan)}${bestiaryNote}`,
            summaryLine: `- Reinforcements join the fight: ${names}. ${note}${budgetNotes(plan)}`,
          };
        }
        if (novel.length) {
          // Everything new was cut by the budget — nothing joins.
          return {
            content: `Reinforcements would exceed the encounter budget (${plan.requested} ${plan.budget} XP for this party): none joined. Resolve the current foes.`,
            summaryLine: "- Reinforcements held back by the encounter budget: none joined.",
          };
        }
        // `isError` porque NADA aconteceu: sem isso a chamada entrava na lista
        // que marca `mechanicalResolved`, e um no-op passava por turno
        // resolvido — desligando a escada de escalação justamente no padrão que
        // ela existe para pegar (bateria 2026-07-25: Hunted Shot chamou
        // lookup_rule + start_combat e fechou o turno com 0 ações gastas).
        return {
          content:
            "Combat is already ACTIVE — nothing was started and no action was spent. This call resolved NOTHING. Act with roll_check (Strike), spend_actions (activity without a roll) or end_combat.",
          isError: true,
        };
      }

      const player = playerCombatant(session.character, session.state.currentHp);
      // Companheiros do roster entram automaticamente como aliados — e contam
      // no tamanho da party, então o orçamento de XP escala junto.
      const allies = companionsOf(session).map(allyCombatant);
      const partySize = partySizeOf([player, ...allies]);
      const plan = planEncounter(specs, 0, { partyLevel, partySize, difficulty });
      const combat = buildCombat([player, ...allies, ...instantiate(plan.accepted)]);
      // This message is the player's turn: give them a full set of actions.
      if (player.actionsRemaining < 3) player.actionsRemaining = 3;
      // Combate novo zera os limites de Frequency de período longo (1/hour...)
      // e o registro de conjurações inimigas.
      combatFrequencyUsed.set(session, new Map());
      combatEnemyCasts.set(session, new Set());
      session.state.combat = combat;
      emit({ type: "state", state: session.state });
      const order = combat.combatants
        .map((c) => `${c.name} (init ${c.initiative}, AC ${c.ac}, ${c.currentHp} HP)`)
        .join("; ");
      // Passivos aplicados pela engine ficam visíveis no resumo (auditoria) —
      // agora com o nome do feat vindo do próprio dado, não de tabela local.
      const passiveStack = sheetStack(session.character, "initiative");
      const passiveTotal = passiveStack.total();
      const passiveNote = passiveTotal
        ? ` [${passiveTotal > 0 ? "+" : ""}${passiveTotal} initiative from ${passiveStack
            .applied()
            .map((m) => m.source ?? m.slug)
            .join(", ")}]`
        : "";
      const note = specs.length
        ? ` Encounter: ${plan.classified} (${plan.totalXp}/${encounterBudget(plan.classified, partySize)} XP).`
        : "";
      return {
        content: `Combat started.${note} Initiative order: ${order}${passiveNote}${budgetNotes(plan)}${bestiaryNote}`,
        summaryLine: `- Combat begins (round 1).${note} Initiative: ${order}.${passiveNote}${budgetNotes(plan)}`,
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
    case "manage_companion": {
      const action = String(input.action ?? "");
      // Mesma limpeza de nome do start_combat: escombros de escaping do JSON
      // quebrado do modelo não podem entrar no roster (quebram o dedupe).
      const compName =
        String(input.name ?? "")
          .replace(/[\\"]/g, "")
          .replace(/\s+/g, " ")
          .trim();
      if (!compName) return { content: "REJECTED: companion needs a name.", isError: true };
      const roster = companionsOf(session);
      const combat = session.state.combat;

      if (action === "leave") {
        const comp = findCompanion(session, compName);
        if (!comp) {
          return {
            content: `No companion named "${compName}" in the party. Current companions: ${roster.map((c) => c.name).join(", ") || "(none)"}. Nothing changed.`,
            isError: true,
          };
        }
        if (combat?.active && combat.combatants.some((c) => c.id === comp.id && !c.defeated)) {
          return {
            content: `REJECTED: ${comp.name} is fighting — a companion cannot leave the party MID-combat. End the fight first (end_combat if it's over narratively).`,
            isError: true,
          };
        }
        session.state.companions = roster.filter((c) => c.id !== comp.id);
        emit({ type: "state", state: session.state });
        return {
          content: `${comp.name} left the party. Companions now: ${session.state.companions.map((c) => c.name).join(", ") || "(none)"}.`,
          summaryLine: `- ${comp.name} leaves the party.`,
        };
      }

      // join
      const existing = findCompanion(session, compName);
      if (existing) {
        return {
          content: `${existing.name} is ALREADY in the party — nothing changed. Do not re-add companions.`,
          isError: true,
        };
      }
      if (roster.length >= MAX_PARTY_SIZE - 1) {
        return {
          content: `REJECTED: the party is full (${MAX_PARTY_SIZE} including the player). Someone must leave before ${compName} can join.`,
          isError: true,
        };
      }
      // Regras como dados, igual ao inimigo: NPC do bestiary usa statblock e
      // nível oficiais; nome inventado cai no benchmark do nível declarado.
      const resolved = resolveCreature(compName);
      const rawLevel = Number(input.level);
      const modelLevel =
        input.level != null && Number.isFinite(rawLevel) ? rawLevel : null;
      const level = resolved.record ? resolved.level : (modelLevel ?? DEFAULT_ENEMY_LEVEL);
      const sb =
        resolved.record?.statblock && resolved.record.level === level
          ? {
              ...resolved.record.statblock,
              sourceName: resolved.record.name,
              traits: resolved.record.traits ?? [],
            }
          : undefined;
      const persona = String(input.persona ?? "").trim();
      const comp = newCompanion(compName, level, persona, sb);
      roster.push(comp);
      // Recrutado no meio de uma luta (raro, mas legítimo — o NPC vira a mesa):
      // entra JÁ como combatente, na ordem de iniciativa.
      let combatNote = "";
      if (combat?.active) {
        const ally = allyCombatant(comp);
        combat.combatants.push(ally);
        combat.combatants.sort((a, b) => b.initiative - a.initiative);
        combatNote = ` They join the ongoing fight (initiative ${ally.initiative}).`;
      }
      emit({ type: "state", state: session.state });
      const statNote = comp.sourceName
        ? `official statblock "${comp.sourceName}", level ${comp.level}`
        : `level ${comp.level}`;
      return {
        content: `${comp.name} joined the party (${statNote}: AC ${comp.ac}, ${comp.currentHp}/${comp.maxHp} HP).${combatNote} Party: ${session.character.name} + ${roster.map((c) => c.name).join(", ")}. The engine will run their combat turns automatically.`,
        summaryLine: `- ${comp.name} joins the party.${combatNote}`,
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
      const spendCharged = turnSet(turnActivityCharged, session);
      // Requirements + Frequency: peek antes de cobrar, commit após.
      const spendReqBlock = requirementBlocked(session, reason);
      if (spendReqBlock) return spendReqBlock;
      const spendFreqBlock = frequencyLimit(session, reason);
      if (spendFreqBlock) return spendFreqBlock;
      // Reação/free action da ficha: custo REAL não sai das 3 ações.
      const spendNonAction = sheetNonActionIn(session, reason);
      if (spendNonAction) {
        const blocked = chargeNonAction(session, you, spendNonAction, emit);
        if (blocked) return blocked;
        commitFrequency(session, reason);
        const label = titleCase(spendNonAction.name);
        const what =
          spendNonAction.kind === "reaction" ? "the player's reaction" : "a free action";
        return {
          content: `${label} used — it costs ${what}, NOT one of the 3 actions. ${you.actionsRemaining} action(s) still remaining.`,
          summaryLine: `- ${label} (${spendNonAction.kind}).`,
        };
      }
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
      // Postura/habilidade auto-dirigida da FICHA entra no registro de efeitos
      // com a duração do dado (Fase 2.6) — o bônus dela deixa de ser prosa.
      const selfEff = mentionedSelfEffect(reason, ownedAbilities(session));
      const effLine = selfEff ? grantPlayerEffect(session, selfEff.name, selfEff.name) : null;
      emit({ type: "state", state: session.state });
      return {
        content: `Spent ${cost} action(s) on: ${reason}. ${you.actionsRemaining} remaining this turn.${effLine ? ` ${effLine.replace(/^- /, "")}` : ""}`,
        summaryLine: `- ${reason} (${cost} action${cost > 1 ? "s" : ""} spent).${effLine ? `\n${effLine}` : ""}`,
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
        const ac = effectiveAC(target, rollOptionsOf(session, target, you!, { action: "Strike" }));
        const statusPen = attackStatusPenalty(
          you!,
          rollOptionsOf(session, you!, target, { action: "Strike", item: owned.name }),
        );
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
          const direct = crit ? base * 2 : base;
          let amount = direct;
          if (record!.splash) amount += record!.splash;
          dmg = { amount, type: record!.damage!.type };
          // Splash é parcela própria: 283 criaturas têm fraqueza a splash-damage.
          const parcels: DamageParcel[] = [{ amount: direct, type: dmg.type }];
          if (record!.splash) {
            parcels.push({ amount: record!.splash, type: dmg.type, category: "splash" });
          }
          const before = target.currentHp;
          const adj = applyDamage(target, parcels);
          turnSet(turnStruck, session).add(target.id);
          let extra = "";
          if (record!.persistent) {
            const pcond = `persistent ${record!.persistent.type} damage ${record!.persistent.number}`;
            if (!target.conditions.includes(pcond)) target.conditions.push(pcond);
            extra = ` + ${pcond}`;
          }
          if (record!.splash) extra += ` (incl. ${record!.splash} splash)`;
          const defeatedNote = target.defeated ? ` — ${target.name} DEFEATED` : "";
          damageLine = ` for ${amount} ${dmg.type}${adj.note}${extra}; ${target.name} ${before}→${target.currentHp} HP${defeatedNote}`;
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
        // A FICHA escolhe a entrada principal, igual ao `costProfileOf`. O
        // índice é primeiro-ganha por ordem alfabética de arquivo, então
        // "Shake it Off" era servido como a REAÇÃO de actions.json — e o modelo
        // ancorava na primeira linha ("reaction") e concluía que não gastava
        // ação, mesmo com o feat de 1 ação logo abaixo na nota de homônimo.
        let primary = local;
        const onSheet = session.character.feats.some(
          (f) => f.toLowerCase().trim() === primary.name.toLowerCase().trim(),
        );
        if (onSheet && primary.category !== "feats") {
          const asFeat = homonymsOf(primary).find((r) => r.category === "feats");
          if (asFeat) primary = asFeat;
        }
        const traits = primary.traits?.length ? ` [${primary.traits.join(", ")}]` : "";
        // Custo explícito: era o campo mais decisivo do registro e não aparecia
        // no texto que o modelo lê — ele tinha que adivinhar pela prosa.
        const cost = actionLabel(primary);
        const costTag = cost ? ` [${cost}]` : "";
        // Homônimos: mostrar o outro lado em vez de escolher escondido.
        const others = homonymsOf(primary)
          .map((r) => {
            const c = actionLabel(r);
            const tr = r.traits?.length ? ` [${r.traits.join(", ")}]` : "";
            return `- ${r.name} (${r.category})${c ? ` [${c}]` : ""}${tr}`;
          })
          .join("\n");
        const alsoBlock = others
          ? `\n\nNOTE — another entry shares this name. The one above is the one THIS character uses:\n${others}`
          : "";
        return {
          content: `${primary.name} (${primary.category})${costTag}${traits}\n${primary.text}${alsoBlock}`,
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

      // Cura via hpDelta FORA de combate: era livre ("descanso") e o modelo
      // inventou +15 no play-test 2026-07-12 — agora existe a tool `rest` com
      // os valores REAIS (overnight/Treat Wounds), então o caminho livre fecha.
      if (
        typeof input.hpDelta === "number" &&
        input.hpDelta > 0 &&
        !combat?.active
      ) {
        return {
          content:
            "REJECTED: healing must come from a REAL source — NOTHING was applied. Use the rest tool for recovery (kind 'overnight' heals CON × level and restores spells; kind 'treat_wounds' rolls a real Medicine check), use_item for potions/elixirs, or cast_spell for healing spells. Retry with the right tool.",
          isError: true,
        };
      }

      // Cura EM COMBATE exige uma fonte real na ficha (regras-como-dados): o
      // modelo curou o jogador com uma "poção" que não existia no inventário.
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
          if (input.hpDelta < 0 && turnSet(turnStruck, session).has(target.id)) {
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
/**
 * Reações de Strike que a ENGINE resolve (whitelist por nome canônico do
 * dataset — "regras como dados"): só o que tem mecânica 100% suportada entra.
 * Goblin Scuttle e afins (movimento) ficam narrativos num engine sem grid;
 * Shield Block fica de fora até termos hardness estruturado.
 */
const STRIKE_REACTIONS = new Set(["reactive strike", "attack of opportunity"]);

/** O que uma tool do jogador provoca (gatilhos RAW aproximados sem grid). */
export function reactionTriggerOf(
  toolName: string,
  input: Record<string, unknown>,
): "manipulate" | "move" | null {
  // Conjurar (trait manipulate na esmagadora maioria) e usar item provocam.
  if (toolName === "use_item" || toolName === "cast_spell") return "manipulate";
  if (toolName === "spend_actions") {
    const reason = String(input.reason ?? "");
    // Step (5 ft cuidadoso) NÃO provoca — todo o resto de movimento sim.
    if (/\bstep\b/i.test(reason)) return null;
    if (/\b(stride|move|moving|dash|run|charge|approach|retreat|reposition|withdraw|flee|climb|leap|jump)\b/i.test(reason)) {
      return "move";
    }
  }
  return null;
}

/**
 * Dispara as reações dos inimigos vivos com Reactive Strike/AoO no statblock
 * e reação disponível: um Strike fora do turno (consome a reação). Linhas
 * extras para o resumo numerado.
 */
export function triggerEnemyReactions(
  session: Session,
  emit: (e: StreamEvent) => void,
): string[] {
  const combat = session.state.combat;
  if (!combat?.active) return [];
  const player = playerOf(combat);
  if (!player || player.defeated) return [];

  const lines: string[] = [];
  for (const enemy of combat.combatants) {
    if (enemy.kind !== "enemy" || enemy.defeated || !enemy.reactionAvailable) continue;
    if (!enemy.sourceName) continue;
    const sb = creatureRecord(enemy.sourceName)?.statblock;
    const reaction = sb?.abilitiesList.find(
      (a) => a.actionType === "reaction" && STRIKE_REACTIONS.has(a.name.toLowerCase()),
    );
    if (!reaction) continue;
    enemy.reactionAvailable = false;
    lines.push(
      strikeAt(session, enemy, player, strikeProfileFor(enemy), emit, {
        reactionName: reaction.name,
      }),
    );
    if (player.defeated) break;
  }

  if (lines.length && combatStatus(combat) === "defeat") {
    combat.active = false;
    lines.push("- Combat ends: DEFEAT — you fall.");
    emit({ type: "state", state: session.state });
  }
  return lines;
}

/**
 * Ticka o dano persistente de todos os combatentes (engine, sem modelo) e
 * devolve as linhas player-safe do resumo. Fecha o combate se o tick decidir
 * a luta e põe o jogador em dying quando ele cai queimando/sangrando.
 */
function applyPersistentTicks(
  session: Session,
  emit: (e: StreamEvent) => void,
): string[] {
  const combat = session.state.combat;
  if (!combat?.active) return [];
  const ticks = tickPersistentDamage(combat);
  if (ticks.length === 0) return [];

  const lines: string[] = [];
  for (const t of ticks) {
    const c = t.combatant;
    let downNote = "";
    if (c.kind === "player") {
      session.state.currentHp = c.currentHp;
      if (c.defeated) downNote = ` — ${enterDying(session, false)}`;
    }
    const fate = t.ended || c.defeated ? "it ends" : "it continues";
    lines.push(
      `- Persistent ${t.type} damage: ${c.name} takes ${t.amount}${t.note} (${t.before}→${t.after} HP)${downNote}; ${fate}.`,
    );
  }

  const status = combatStatus(combat);
  if (status !== "ongoing") {
    combat.active = false;
    lines.push(
      status === "defeat"
        ? "- Combat ends: DEFEAT — you fall."
        : "- Combat ends: VICTORY.",
    );
  }
  emit({ type: "state", state: session.state });
  return lines;
}

/**
 * POR QUE A REAÇÃO DO JOGADOR É RESOLVIDA AQUI (achado de 2026-07-26, ao
 * consertar o juiz da bateria): `chargeNonAction` só era alcançável por tool
 * call do modelo, ou seja, durante o turno do JOGADOR. Mas o revide inimigo é
 * resolvido em código DEPOIS do estágio de regras — não havia instante em que o
 * modelo pudesse reagir ao golpe. A reação era estruturalmente impossível de
 * disparar no gatilho certo, e 9 cenários da bateria passavam sem o feat ter
 * sido usado. Isto é o simétrico de `triggerEnemyReactions`.
 *
 * A tabela `PLAYER_STRIKE_REACTIONS` mora em combat.ts porque o juiz da bateria
 * também a lê — ver o comentário lá.
 */

/** O personagem carrega um escudo no Equipment/armor? (Reactive Shield). */
function hasShield(c: Character): boolean {
  const shield = /shield/i;
  return (
    (c.equipment ?? []).some((e) => shield.test(e.name)) ||
    (c.armor ?? []).some((a) => shield.test(a.name))
  );
}

/**
 * A reação defensiva do jogador contra ESTE Strike, se houver uma que MUDE o
 * resultado. Devolve null quando não há reação aplicável, quando ela já foi
 * gasta nesta rodada, ou quando o bônus não salvaria o golpe.
 *
 * Desvio deliberado e determinístico: a engine só gasta a reação quando ela
 * MUDA o desfecho (transforma acerto em erro, ou crítico em acerto). RAW o
 * jogador declara antes de saber o resultado; aqui não há a quem perguntar no
 * meio do revide, e queimar a reação num golpe que já erraria seria pior para
 * o jogador do que qualquer aproximação. Vale a mesma lógica de "1 mensagem =
 * 1 turno": a engine joga o lado do jogador de forma previsível.
 */
function playerReactionVsStrike(
  session: Session,
  target: Combatant,
  result: CheckResult,
  melee: boolean,
): { name: string; acBonus: number; degree: DegreeOfSuccess } | null {
  if (target.kind !== "player" || !target.reactionAvailable) return null;
  // Leitura defensiva: isto roda a CADA golpe inimigo, e ficha sem lista de
  // feats (save antigo, fixture parcial) significa "sem reações" — nunca
  // derrubar o turno inteiro por causa disso.
  for (const featName of session.character?.feats ?? []) {
    const spec = PLAYER_STRIKE_REACTIONS[featName.toLowerCase().trim()];
    if (!spec) continue;
    if (spec.meleeOnly && !melee) continue;
    if (spec.needsShield && !hasShield(session.character)) continue;
    const degree = degreeOfSuccess(result.die, result.total, result.dc + spec.acBonus);
    if (degree === result.degree) continue; // não muda nada: guarda a reação
    target.reactionAvailable = false;
    return { name: titleCase(featName), acBonus: spec.acBonus, degree };
  }
  return null;
}

/**
 * Um Strike resolvido pela engine entre dois combatentes — turno inimigo,
 * reações (Reactive Strike) e turno de ALIADO (Fase 2). Usa o MAP corrente do
 * atacante (RAW: o MAP só reseta no começo do turno DELE, então a reação fora
 * do turno herda o acumulado), aplica dano/persistente e devolve a linha
 * player-safe. Só o JOGADOR tem o subsistema de dying/estado persistente da
 * sessão; aliado/inimigo a 0 HP fica `defeated` (inconsciente) e pronto.
 */
function strikeAt(
  session: Session,
  attacker: Combatant,
  target: Combatant,
  profile: StrikeProfile,
  emit: (e: StreamEvent) => void,
  opts: { reactionName?: string } = {},
): string {
  const strikeName = profile.label === "Strike" ? "Strike" : `${profile.label} Strike`;
  const map = mapPenalty(attacker.mapProgress, profile.agile);
  const mapTag = map ? ` [MAP ${map}${profile.agile ? " agile" : ""}]` : "";
  // Same condition math as player Strikes (off-guard/frightened both ways).
  const ac = effectiveAC(target, rollOptionsOf(session, target, attacker, { action: "Strike" }));
  const reactionTag = opts.reactionName ? `Reaction (${opts.reactionName}): ` : "";
  const label = `${reactionTag}${attacker.name} ${strikeName} vs ${target.name} (AC ${ac}${map ? `, MAP ${map}` : ""})`;
  const attackRo = rollOptionsOf(session, attacker, target, { action: "Strike" });
  const result = rollCheck(label, profile.bonus + map + attackStatusPenalty(attacker, attackRo), ac);
  attacker.mapProgress += 1;
  // Reação DEFENSIVA do jogador (Nimble Dodge, Reactive Shield…): dispara aqui,
  // que é o único ponto onde a engine sabe que o gatilho ("uma criatura te
  // ataca") ocorreu. Ajusta o grau ANTES de qualquer dano ser aplicado.
  let reactionNote = "";
  if (attacker.kind === "enemy") {
    // Sem posicionamento, "melee" é o que o statblock indica: ataque sem
    // rangeIncrement é corpo a corpo (mesma leitura de `strikeProfileFrom`).
    const melee = !/bow|crossbow|sling|dart|javelin|thrown|ranged/i.test(profile.label);
    const reacted = playerReactionVsStrike(session, target, result, melee);
    if (reacted) {
      result.dc += reacted.acBonus;
      result.degree = reacted.degree;
      reactionNote = ` [Reaction: ${reacted.name}, +${reacted.acBonus} AC → ${DEGREE_EN[reacted.degree]}]`;
    }
  }
  const crit = result.degree === "criticalSuccess";
  const hit = crit || result.degree === "success";
  let dmgLine = "";
  let amount: number | null = null;
  if (hit) {
    // Soma todas as entradas de dano do ataque; crit dobra o total.
    const parts = profile.damage.map((d) => ({
      type: d.type,
      rolled: rollFormula(d.formula),
    }));
    amount = parts.reduce((sum, p) => sum + p.rolled, 0);
    if (crit) amount *= 2;
    const before = target.currentHp;
    // Cada entrada do statblock entra tipada: dobrar parcela a parcela dá
    // exatamente o mesmo total (×2 não arredonda), e preserva os tipos.
    const adj = applyDamage(
      target,
      parts.map((p) => ({ amount: crit ? p.rolled * 2 : p.rolled, type: p.type })),
    );
    if (target.kind === "player") session.state.currentHp = target.currentHp;
    // Dano persistente do ataque (dados do statblock) vira condição no
    // hit; mesmo tipo não empilha (mantém a existente).
    let persistentNote = "";
    for (const p of profile.persistent) {
      const already = target.conditions.some((x) =>
        new RegExp(`^persistent\\s+${p.type}\\s+damage`, "i").test(x.trim()),
      );
      if (already) continue;
      const cond = `persistent ${p.type} damage ${p.formula}`;
      target.conditions = [...target.conditions, cond];
      if (target.kind === "player") {
        session.state.conditions = [...session.state.conditions, cond];
      }
      persistentNote += ` + persistent ${p.type} damage`;
    }
    const down = target.defeated
      ? target.kind === "player"
        ? ` — ${enterDying(session, crit)}`
        : ` — ${target.name} goes DOWN`
      : "";
    const typeNote =
      parts.length === 1 && parts[0]!.type
        ? ` ${parts[0]!.type}`
        : parts.length > 1
          ? ` (${parts.map((p) => `${crit ? p.rolled * 2 : p.rolled} ${p.type || "damage"}`).join(" + ")})`
          : "";
    dmgLine = ` for ${amount}${typeNote}${adj.note}${persistentNote}; ${target.name} ${before}→${target.currentHp} HP${down}`;
  }
  const verb = crit ? "CRITICAL HIT" : hit ? "HIT" : "MISS";
  result.attack = {
    attacker: attacker.name,
    target: target.name,
    attackerKind: attacker.kind,
    outcome: crit ? "criticalHit" : hit ? "hit" : "miss",
    damage: amount,
    damageType: profile.damage[0]?.type || null,
  };
  emit({ type: "check", result });
  const line = `- ${reactionTag}${attacker.name} ${strikeName} vs ${target.name}${mapTag}${reactionNote} → ${verb}${dmgLine}.`;
  emit({ type: "state", state: session.state });
  return line;
}

/**
 * Turno de conjuração de um inimigo caster — política DETERMINÍSTICA (o 12B
 * nunca decide): 1x por combate, a magia DANOSA estruturada de maior rank do
 * statblock; o jogador rola o save REAL da ficha contra o spell DC oficial
 * (ou a magia ataca vs AC). Retorna a linha, ou null se não conjurou.
 */
function enemySpellTurn(
  session: Session,
  enemy: Combatant,
  player: Combatant,
  emit: (e: StreamEvent) => void,
): string | null {
  if (!enemy.sourceName) return null;
  const casting = creatureRecord(enemy.sourceName)?.statblock?.spellcasting;
  if (!casting?.length) return null;
  const done = combatEnemyCasts.get(session);
  if (!done || done.has(enemy.id)) return null;

  let pick: {
    dc: number;
    attack: number;
    name: string;
    rank: number;
    mech: SpellMechanics;
  } | null = null;
  for (const entry of casting) {
    for (const sp of entry.spells) {
      const mech = spellRecord(sp.name)?.spell;
      if (!mech) continue;
      const damaging = mech.damage.some(
        (d) => d.kinds.includes("damage") && !d.kinds.includes("healing"),
      );
      if (!damaging || (!mech.defense?.save && !mech.attack)) continue;
      if (!pick || sp.rank > pick.rank) {
        pick = { dc: entry.dc, attack: entry.attack, name: sp.name, rank: sp.rank, mech };
      }
    }
  }
  if (!pick) return null;
  done.add(enemy.id);

  const castRank = Math.max(pick.mech.rank, pick.rank);
  const dmg = rollSpellDamage(pick.mech, castRank);

  if (pick.mech.defense?.save) {
    const saveKey = pick.mech.defense.save as "fortitude" | "reflex" | "will";
    const mod = session.character.saves[saveKey];
    const result = rollCheck(
      `${pick.name} (${enemy.name}): ${player.name} ${saveKey} save vs spell DC ${pick.dc}`,
      mod,
      pick.dc,
    );
    emit({ type: "check", result });
    // Basic save; saves não-basic com dano usam os mesmos multiplicadores
    // (aproximação honesta — o efeito extra fica para a narração).
    const mult =
      result.degree === "criticalFailure"
        ? 2
        : result.degree === "failure"
          ? 1
          : result.degree === "success"
            ? 0.5
            : 0;
    const amount = Math.floor(dmg.total * mult);
    let downNote = "";
    let adjNote = "";
    const before = player.currentHp;
    if (amount > 0) {
      adjNote = applyDamage(player, scaleParcels(dmg.parcels, amount)).note;
      session.state.currentHp = player.currentHp;
      if (player.defeated) downNote = ` — ${enterDying(session, result.degree === "criticalFailure")}`;
    }
    emit({ type: "state", state: session.state });
    const dmgNote =
      amount > 0
        ? ` takes ${amount} ${dmg.type || "damage"}${adjNote} (${before}→${player.currentHp} HP)${downNote}`
        : " is unharmed";
    return `- ${enemy.name} casts ${pick.name}: ${player.name} ${saveKey} save ${DEGREE_EN[result.degree]} →${dmgNote}.`;
  }

  // Spell attack contra a AC do jogador (sem MAP: primeira ação do turno).
  const ac = effectiveAC(player, rollOptionsOf(session, player, enemy, { action: pick.name }));
  const result = rollCheck(
    `${pick.name} spell attack: ${enemy.name} vs ${player.name} (AC ${ac})`,
    pick.attack + attackStatusPenalty(enemy, rollOptionsOf(session, enemy, player, { action: pick.name })),
    ac,
  );
  const crit = result.degree === "criticalSuccess";
  const hit = crit || result.degree === "success";
  let dmgLine = "";
  if (hit) {
    const amount = crit ? dmg.total * 2 : dmg.total;
    const before = player.currentHp;
    const adj = applyDamage(player, scaleParcels(dmg.parcels, amount));
    session.state.currentHp = player.currentHp;
    const down = player.defeated ? ` — ${enterDying(session, crit)}` : "";
    dmgLine = ` for ${amount} ${dmg.type || "damage"}${adj.note}; ${player.name} ${before}→${player.currentHp} HP${down}`;
  }
  result.attack = {
    attacker: enemy.name,
    target: player.name,
    attackerKind: "enemy",
    outcome: crit ? "criticalHit" : hit ? "hit" : "miss",
    damage: hit ? dmg.total : null,
    damageType: dmg.type || null,
  };
  emit({ type: "check", result });
  emit({ type: "state", state: session.state });
  return `- ${enemy.name} casts ${pick.name} at ${player.name} → ${crit ? "CRITICAL HIT" : hit ? "HIT" : "MISS"}${dmgLine}.`;
}

export function resolveEnemyTurns(
  session: Session,
  emit: (e: StreamEvent) => void,
): string[] {
  const combat = session.state.combat;
  const lines: string[] = [];
  if (!combat?.active) return lines;
  const player = playerOf(combat);
  if (!player) return lines;

  // Defensores vivos do lado do jogador, na ordem de iniciativa do array. O
  // revide DISTRIBUI os golpes por round-robin determinístico entre eles —
  // sem aliados a lista é só o jogador e o comportamento é o de sempre.
  const defenders = () =>
    combat.combatants.filter(
      (c) => (c.kind === "player" || c.kind === "ally") && !c.defeated,
    );
  let rr = 0;
  const nextTarget = (): Combatant | undefined => {
    const d = defenders();
    return d.length ? d[rr++ % d.length] : undefined;
  };

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
    // Turno DELE começa: MAP reseta agora (a reação fora de turno herda o
    // acumulado — RAW).
    enemy.mapProgress = 0;
    // Caster conjura sua melhor magia (2 ações) e fica com 1 Strike; os
    // demais fazem os 2 Strikes de sempre. Política determinística: a magia
    // vai no JOGADOR (casters focam o líder) — com ele caído, ninguém conjura.
    const castLine = !player.defeated
      ? enemySpellTurn(session, enemy, player, emit)
      : null;
    if (castLine) lines.push(castLine);
    // Statblock real (via sourceName) quando houver; senão benchmark do nível.
    const profile = strikeProfileFor(enemy);
    const strikes = castLine ? 1 : 2;
    for (let strike = 0; strike < strikes; strike++) {
      const target = nextTarget();
      if (!target) break;
      lines.push(strikeAt(session, enemy, target, profile, emit));
    }
    if (defenders().length === 0) break;
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
 * Roster de companheiros para o rules stage: o modelo precisa saber quem JÁ
 * viaja com o jogador (para não re-recrutar, e para mirar/curar pelo nome).
 * "" sem companheiros.
 */
function partyBlock(session: Session): string {
  const roster = companionsOf(session);
  if (!roster.length) return "";
  const lines = roster
    .map((c) => {
      const cond = c.conditions.length ? `, ${c.conditions.join(", ")}` : "";
      return `- ${c.name} (level ${c.level}): ${c.currentHp}/${c.maxHp} HP${cond}`;
    })
    .join("\n");
  return `# PARTY — NPC companions traveling with the player (already recruited; do NOT call manage_companion 'join' for them; the engine runs their combat turns automatically):\n${lines}`;
}

/**
 * Turnos dos ALIADOS (Fase 2/ADR-004), resolvidos em código como o turno
 * inimigo — o modelo nunca gerencia companheiro. Aliados agem depois do
 * jogador e ANTES do revide inimigo, em ordem de iniciativa: 2 Strikes com MAP
 * (statblock real via sourceName, senão benchmark), alvo = primeiro inimigo
 * vivo. Aliado caster luta como marcial por enquanto (conjuração de aliado é
 * tarefa futura registrada no ROADMAP — exigiria política própria de alvo).
 */
export function resolveAllyTurns(
  session: Session,
  emit: (e: StreamEvent) => void,
): string[] {
  const combat = session.state.combat;
  const lines: string[] = [];
  if (!combat?.active) return lines;
  const allies = combat.combatants.filter((c) => c.kind === "ally" && !c.defeated);
  if (allies.length === 0) return lines;

  for (const ally of allies) {
    // Turno DELE começa: MAP reseta (idêntico ao inimigo).
    ally.mapProgress = 0;
    const profile = strikeProfileFor(ally);
    for (let strike = 0; strike < 2; strike++) {
      const target = livingEnemy(combat);
      if (!target) break;
      lines.push(strikeAt(session, ally, target, profile, emit));
    }
    if (!combat.combatants.some((c) => c.kind === "enemy" && !c.defeated)) break;
  }

  // Aliados podem fechar a luta sozinhos (o revide inimigo nem chega a rodar).
  if (combatStatus(combat) === "victory") {
    combat.active = false;
    lines.push("- Combat ends: VICTORY.");
  }
  if (lines.length) emit({ type: "state", state: session.state });
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
    "To attack, call roll_check with the target's id/name; on a hit the engine applies damage automatically. Do NOT roll for enemies OR allies — after the player's turn the engine resolves the ally companions' turns and the enemies' Strikes automatically. Only call end_turn if the player passes or ends with actions to spare. If the fight is over without a kill (foes flee/surrender/are spared, or the player disengages and the scene moves on), you MUST call end_combat — never keep resolving non-combat messages inside a stale combat.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * STAGE 1 — Rules: the rules model resolves the mechanics via tool use (no
 * narration). Emits `check`/`state` events but NOT `delta`. Runs on its own
 * message history (doesn't pollute the narrative dialogue) and returns the
 * mechanical summary.
 *
 * Exportada para teste: o ramo de `dying` resolve o turno inteiro em código e
 * retorna ANTES de qualquer chamada ao modelo, então é testável sem GPU.
 */
export async function runRulesStage(
  session: Session,
  emit: (e: StreamEvent) => void,
): Promise<string> {
  // Snapshot the player's persistent state so the summary can tell the
  // narrator whether it actually CHANGED this turn (stale "HP 56/65" lines made
  // the narrator dramatize old wounds out of nowhere).
  const hpBefore = session.state.currentHp;
  const condsBefore = session.state.conditions.join("|");
  // A luta termina em NOVE pontos diferentes (end_combat, vitória, derrota,
  // tick persistente que decide, dying...). Detectar a TRANSIÇÃO aqui pega
  // todos com uma linha, em vez de nove remendos que a próxima saída esquece.
  const inCombatBefore = session.state.combat?.active === true;

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
    // Solo, cair fecha o combate (derrota) e este ramo roda com o combate já
    // inativo. Com ALIADOS vivos o combate segue ativo enquanto o jogador
    // sangra — este ramo então também move o mundo (aliados lutam, inimigos
    // revidam neles) para a luta não congelar.
    const dyingCombat = session.state.combat;
    let line: string;
    if (newDying >= 4) {
      session.state.conditions = ["dead"];
      if (dyingCombat?.active) dyingCombat.active = false;
      line = `Recovery check: ${DEGREE_EN[degree]} (d20 ${die} vs DC ${10 + dyingNow}) — dying reaches 4. ${session.character.name} DIES. This is final.`;
    } else if (newDying === 0) {
      const wounded = conditionValueIn(session.state.conditions, "wounded") + 1;
      let conds = setValuedCondition(session.state.conditions, "dying", 0);
      conds = conds.filter((c) => !/^unconscious$/i.test(c));
      session.state.conditions = setValuedCondition(conds, "wounded", wounded);
      session.state.currentHp = 1;
      // Combate ainda ativo (aliados seguraram a luta): o combatente do
      // jogador REVIVE junto com o estado — estado nunca mente.
      if (dyingCombat?.active) {
        const youNow = playerOf(dyingCombat);
        if (youNow) {
          youNow.defeated = false;
          youNow.currentHp = 1;
          youNow.conditions = [...session.state.conditions];
        }
      }
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

    // Aliados vivos mantêm a rodada girando mesmo com o jogador caído.
    const dyingExtra: string[] = [];
    if (dyingCombat?.active && dyingCombat.combatants.some((c) => c.kind === "ally" && !c.defeated)) {
      dyingExtra.push(...resolveAllyTurns(session, emit));
      if (dyingCombat.active) dyingExtra.push(...resolveEnemyTurns(session, emit));
      if (dyingCombat.active) dyingExtra.push(...applyPersistentTicks(session, emit));
      if (dyingCombat.active) {
        tickEndOfRound(dyingCombat);
        dyingExtra.push(...expirePlayerEffects(session, "round"));
        emit({ type: "state", state: session.state });
      }
    }
    // Caído não congela o relógio dos efeitos: este ramo retorna aqui, então a
    // expiração de fim de luta precisa acontecer nele também.
    if (inCombatBefore && session.state.combat?.active !== true) {
      dyingExtra.push(...expirePlayerEffects(session, "combat-end"));
    }
    return [
      `1. ${line}`,
      ...dyingExtra.map((l, i) => `${i + 2}. ${l.replace(/^- /, "")}`),
    ].join("\n");
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
        partyBlock(session),
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
  /** Linhas de reação inimiga aguardando aviso ao rules model (pós tool results). */
  const pendingReactionNotices: string[] = [];
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
      top_p: 0.95,
      ...SAMPLERS,
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
      // 240 e não 80: este log É a fonte de verdade da bateria de feats (o
      // harness lê o stdout do servidor para saber o que a engine respondeu).
      // Com 80 caracteres, notas que a engine escreve no FIM da mensagem —
      // como o `[+2 initiative from Incredible Initiative]` do start_combat —
      // eram cortadas, e o juiz não conseguia verificar o passivo.
      console.log(
        `[GM][rules]   tool ${tc.function.name}(${JSON.stringify(args)}) -> ${
          outcome.isError ? "ERROR: " : ""
        }${outcome.content.slice(0, 240)}`,
      );
      if (outcome.summaryLine) summaryLines.push(outcome.summaryLine);
      if (outcome.endedTurn) endedTurn = true;
      // Reações inimigas (engine): manipulate (use_item) e movimento provocam
      // Reactive Strike/AoO de quem tem a reação no statblock e ela disponível.
      // (Aviso ao modelo só DEPOIS do loop — tool results têm que vir direto.)
      if (!outcome.isError && reactionTriggerOf(tc.function.name, args)) {
        const reactionLines = triggerEnemyReactions(session, emit);
        summaryLines.push(...reactionLines);
        pendingReactionNotices.push(...reactionLines);
      }
      if (
        !outcome.isError &&
        ["roll_check", "use_item", "cast_spell", "rest", "spend_actions", "update_state", "start_combat", "end_combat", "manage_companion"].includes(
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
    // Reações disparadas nesta iteração: o rules model precisa saber (o resumo
    // numerado vai só para o narrador). Depois dos tool results, protocolo OK.
    if (pendingReactionNotices.length) {
      messages.push({
        role: "user",
        content: `[ENGINE] Enemy reaction(s) already resolved by the engine — account for them, do NOT re-roll:\n${pendingReactionNotices.join("\n")}`,
      });
      pendingReactionNotices.length = 0;
    }
    return toolCalls.length;
  };

  /**
   * Escalada: insiste até algo ser RESOLVIDO ou o orçamento acabar.
   *
   * Antes cada escada fazia `if ((await runIteration(...)) === 0) break`, e uma
   * resposta em prosa (zero tool calls) a encerrava na PRIMEIRA das 3
   * tentativas — justamente o que o modelo faz no padrão "consulta a regra e
   * para". As 3 tentativas existiam no papel e nunca eram usadas. Isso
   * respondia por 3 das 4 falhas da bateria de 2026-07-25 (Double Shot,
   * Shake it Off, Esoteric Wayfinder).
   */
  const escalate = async (
    label: string,
    budget: number,
    done: () => boolean,
  ): Promise<void> => {
    for (let i = 0; i < budget; i++) {
      await runIteration(`${label}${i}`);
      if (done()) return;
    }
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
      // Em combate, "resolvido" é ter GASTO ação, encerrado o turno ou fechado
      // o combate — não um `mechanicalResolved` genérico, que uma chamada
      // inócua (start_combat num combate já ativo) conseguia satisfazer.
      await escalate(
        "recheck",
        3,
        () =>
          endedTurn ||
          !session.state.combat?.active ||
          (playerOf(session.state.combat)?.actionsRemaining ?? 3) < 3,
      );
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
    // `anyTool` sem nada resolvido = o modelo chamou SÓ tools de consulta
    // (lookup_rule/get_character) e encerrou o turno. `namedActivity` sozinho
    // não pegava isso: ele só indexa `actionType === "action"`, então uma free
    // action como Esoteric Wayfinder passava batido (bateria 2026-07-25).
    const consultedOnly = anyTool;
    if (invoked || consultedOnly) {
      messages.push({
        role: "user",
        content: invoked
          ? `[ENGINE CHECK] The player invoked "${invoked}", which has RULES (an action, usually with a check), but you resolved NOTHING mechanically. Resolve it now: roll_check with its listed skill vs a real DC (lookup_rule first if unsure) and apply any effect with update_state. Only if it truly cannot apply in this scene, answer in one line why.`
          : "[ENGINE CHECK] You looked rules up but resolved NOTHING mechanically — consulting is not resolving, and a turn cannot end on a lookup. Resolve it now: roll_check against a real DC for what the player attempted, spend_actions if it costs actions without a roll, or update_state for its effect. Only if it truly cannot apply in this scene, answer in one line why.",
      });
      await escalate("activity-recheck", 2, () => mechanicalResolved);
    }
  }

  // The player's whole turn is this one message. If they actually spent an
  // action (a Strike decrements actionsRemaining below 3) or explicitly ended,
  // allies act and then the enemies take their turn NOW — all in code.
  const combat = session.state.combat;
  const you = combat ? playerOf(combat) : undefined;
  const enemiesAlive =
    combat?.combatants.some((c) => c.kind === "enemy" && !c.defeated) ?? false;
  const tookTurn = endedTurn || (you ? you.actionsRemaining < 3 : false);
  if (combat?.active && enemiesAlive && tookTurn) {
    // Aliados agem entre o jogador e o revide (podem fechar a luta sozinhos).
    summaryLines.push(...resolveAllyTurns(session, emit));
    if (combat.active) {
      summaryLines.push(...resolveEnemyTurns(session, emit));
    }
    // Dano persistente ticka no fim da rodada (dano → flat check DC 15).
    if (combat.active) {
      summaryLines.push(...applyPersistentTicks(session, emit));
    }
    // End-of-round upkeep: off-guard expires, frightened N decrements, e os
    // efeitos com prazo em rodadas vencem (Fase 2.6).
    if (combat.active) {
      tickEndOfRound(combat);
      summaryLines.push(...expirePlayerEffects(session, "round"));
      emit({ type: "state", state: session.state });
    }
  }

  // Saiu da luta: o que durava "este encontro" ou tinha prazo em rodadas acaba
  // aqui — inclusive quando a luta fechou por vitória/derrota, sem end_combat.
  if (inCombatBefore && session.state.combat?.active !== true) {
    summaryLines.push(...expirePlayerEffects(session, "combat-end"));
  }
  // Entrou na luta: quem foi concedido na exploração ganha prazo em rodadas
  // agora que existe relógio (sem isso duraria a luta inteira).
  if (!inCombatBefore && session.state.combat?.active === true && session.state.effects?.length) {
    session.state.effects = anchorToRound(session.state.effects, session.state.combat.round);
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
export function buildMechanicalSummary(
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
  // Fora de combate o vazio era silencioso: o modelo consultava a regra, não
  // resolvia nada, e o narrador ficava livre para dizer que a atividade deu
  // certo. Doutrina 4 — o que não está nas linhas não aconteceu.
  if (!combat?.active && summaryLines.length === 0 && anyTool) {
    lines.unshift(
      "NOTHING was resolved mechanically this turn: the rules were consulted but no check was rolled, no cost was paid and no effect was applied. Narrate only the attempt and the atmosphere — do NOT state that it worked, that anything changed, or that any rule took effect.",
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
 * Linha de estado ABSOLUTO do personagem para o narrador — "estado nunca
 * mente" aplicado à vida/consciência. Promovida a código após o play-test de
 * 2026-07-12: o prompt já proibia (regra DYING AND DEATH) e o narrador ainda
 * manteve o jogador num "limbo pós-morte" por 3 turnos DEPOIS do resumo dizer
 * STABILIZES. Só menciona números de HP quando o personagem está mal —
 * repetir HP saudável todo turno fazia o narrador inventar dores fantasma.
 */
export function playerStateLine(session: Session): string {
  const name = session.character.name;
  const conds = session.state.conditions;
  const hp = session.state.currentHp;
  const max = session.character.maxHp;
  if (conds.some((c) => /^dead$/i.test(c))) {
    return `[PLAYER STATE: ${name} is DEAD. Their story has ended — narrate aftermath only.]`;
  }
  const dying = conditionValueIn(conds, "dying");
  if (dying > 0 || conds.some((c) => /^unconscious$/i.test(c))) {
    return `[PLAYER STATE: ${name} is UNCONSCIOUS and DYING ${dying || 1} — NOT dead. They cannot act, speak, or perceive clearly; do not kill them or wake them yourself.]`;
  }
  const hurt = hp <= Math.ceil(max * 0.25) ? ` They are badly hurt (${hp}/${max} HP) but standing.` : "";
  return `[PLAYER STATE: ${name} is ALIVE, conscious and able to act.${hurt} NEVER narrate them as dead, dying, unconscious, or drifting in any void/afterlife/limbo.]`;
}

/**
 * Apara um texto interrompido no meio da frase (max_tokens) até o último
 * terminador de frase. Sem frase completa nenhuma, devolve o texto como veio
 * (parcial é melhor que vazio).
 */
export function trimToCompleteSentence(text: string): string {
  const t = text.trimEnd();
  if (/[.!?…]["”'’*)\]]*$/.test(t)) return t;
  let cut = -1;
  const re = /[.!?…]["”'’*)\]]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) cut = m.index + m[0].length;
  return cut > 0 ? t.slice(0, cut) : t;
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
  // Memória do protagonista (brain): map + cauda do journal + nós citados no
  // turno — continuidade entre sessões sem custo de geração extra.
  const lastUser = [...session.messages]
    .reverse()
    .find((m) => m.role === "user" && typeof m.content === "string");
  const knowledge = brainKnowledge(
    `${typeof lastUser?.content === "string" ? lastUser.content : ""}\n${mechanical}`,
  );
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
      knowledge,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };

  // The turn's results go in a FINAL user message, not the system prompt:
  // small models follow the most recent context far more reliably, and this is
  // the one block the narration must not contradict. Not persisted to history.
  // A linha de PLAYER STATE fecha o modo de falha do limbo: vida/consciência
  // do personagem SEMPRE explícitas, mesmo em turno sem rolagem.
  const stateLine = playerStateLine(session);
  // Gate "uma voz por vez" (ADR-004): decidido em código, injetado aqui — a
  // posição mais obedecida do contexto. Persona de NO MÁXIMO um companheiro;
  // os demais recebem ordem explícita de silêncio.
  const companions = session.state.companions ?? [];
  const voiceLine = voiceDirective(
    pickVoice(companions, {
      playerText: typeof lastUser?.content === "string" ? lastUser.content : "",
      mechanical,
      turn: session.messages.filter((m) => m.role === "user").length,
    }),
    companions,
  );
  const tail = [stateLine, voiceLine].filter(Boolean).join("\n");
  const resultsMessage: ChatCompletionMessageParam = {
    role: "user",
    content: mechanical
      ? `[GM ENGINE — WHAT ACTUALLY HAPPENED THIS TURN. Narrate EVERY numbered line below, in order, faithfully: never flip a miss into a hit, never omit a blow that landed on the player. These lines are COMPLETE: if the player's message declared an item, attack, or ability that does NOT appear below, it DID NOT HAPPEN — the engine rejected or ignored it (usually the item isn't in their Equipment). Show its absence in-fiction ("your hand finds no such flask in your pack") instead of narrating it working. Don't quote the raw terms or numbers; show them as story.]\n${mechanical}\n${tail}`
      : `[GM ENGINE] No roll was needed and NO mechanical effect happened (no damage, no healing, no item consumed). Resolve the player's declared action plainly and stay in the CURRENT scene — do NOT invent new locations, events, or plot, and do NOT narrate items/abilities taking mechanical effect.\n${tail}`,
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
    // the prompt is a soft ask; this enforces it). 450 cortava narrações
    // legítimas no meio da frase (play-test 2026-07-12: comeu o crit do
    // nocaute); com 64k de contexto o teto sobe e a continuação vira exceção,
    // sem soltar o freio do rambling.
    max_tokens: 700,
    top_p: 0.9,
    ...SAMPLERS,
    ...NO_REASONING,
  });

  let narration = "";
  let finishReason: string | null = null;
  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    const delta = choice?.delta?.content;
    if (delta) {
      narration += delta;
      emit({ type: "delta", text: delta });
    }
    if (choice?.finish_reason) finishReason = choice.finish_reason;
  }

  // Truncado pelo max_tokens no MEIO da frase (play-test 2026-07-12: o corte
  // comeu justamente o crit que derrubou o jogador): UMA continuação curta
  // fecha o pensamento. Se ainda assim terminar quebrado, o histórico guarda
  // só até a última frase completa — lixo truncado não vira contexto.
  if (finishReason === "length" && narration.trim()) {
    console.log("[GM][narrative] truncated by max_tokens — requesting a short wrap-up");
    try {
      const cont = await client.chat.completions.create({
        model: NARRATIVE_MODEL,
        messages: [
          narrativeSystem,
          ...session.messages.slice(-NARRATIVE_CONTEXT_MESSAGES),
          resultsMessage,
          { role: "assistant", content: narration },
          {
            role: "user",
            content:
              "[GM ENGINE] Your narration was CUT OFF mid-sentence by a length limit. Continue EXACTLY from where it stopped and wrap the scene up within TWO short sentences. Do not repeat anything already written and do not start a new paragraph of events.",
          },
        ],
        stream: true,
        temperature: inCombat ? 0.4 : 0.6,
        max_tokens: 110,
        top_p: 0.9,
        ...SAMPLERS,
        ...NO_REASONING,
      });
      for await (const chunk of cont) {
        const delta = chunk.choices[0]?.delta?.content;
        if (delta) {
          narration += delta;
          emit({ type: "delta", text: delta });
        }
      }
    } catch (err) {
      console.warn(
        "[GM][narrative] wrap-up call failed:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  session.messages.push({
    role: "assistant",
    content: trimToCompleteSentence(narration),
  });
}

/** Cliente do write pass do brain: MESMO modelo residente, temp baixa. */
async function brainComplete(prompt: string): Promise<string> {
  const resp = await client.chat.completions.create({
    model: NARRATIVE_MODEL,
    messages: [{ role: "user", content: prompt }],
    temperature: 0.1,
    max_tokens: 500,
    top_p: 0.95,
    ...SAMPLERS,
    ...NO_REASONING,
  });
  return resp.choices[0]?.message?.content ?? "";
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
    // Relógio do brain: 1 mensagem do jogador = 1 turno ("S3.T12").
    const stamp = brainTurnStamp();

    emit({ type: "phase", phase: "rules" });
    const mechanical = await runRulesStage(session, emit);
    // Feridas de combate persistem no roster — combate e roster nunca divergem.
    syncCompanions(session);
    console.log(`[GM] mechanical summary: ${mechanical.slice(0, 160) || "(empty)"}`);

    // Journaling determinístico (engine, sem modelo): ground truth mecânico.
    brainJournal(mechanical, stamp);

    emit({ type: "phase", phase: "narrative" });
    await runNarrativeStage(session, mechanical, emit);

    console.log("[GM] turn finished");
    emit({ type: "done" });

    // Write pass do brain DEPOIS do done (fire-and-forget, fila coalescida):
    // só texto que o jogador viu — LORE.md nunca entra (fronteira revelada).
    const lastAssistant = [...session.messages]
      .reverse()
      .find((m) => m.role === "assistant" && typeof m.content === "string");
    queueBrainWrite(
      {
        playerText,
        mechanical,
        narration: typeof lastAssistant?.content === "string" ? lastAssistant.content : "",
      },
      brainComplete,
    );

    // Save-game da campanha: todo turno completo persiste o ponto de retomada.
    saveSession(session);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[GM] turn ERROR:", message);
    emit({ type: "error", message });
  }
}
