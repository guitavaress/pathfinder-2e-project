/**
 * Fonte única de verdade dos argumentos das tools do GM.
 *
 * POR QUE ESTE ARQUIVO EXISTE (achado de 2026-07-24, llama.cpp `505b1ed`):
 * com `--jinja` + o template do Gemma 4, o llama-server já monta uma gramática
 * lazy disparada por `<|tool_call>` (`common/chat.cpp:1412-1430`) que garante o
 * FORMATO: o nome da tool é um dos declarados e o dict de argumentos é
 * sintaticamente válido. Mas o schema dos argumentos é IGNORADO nesse caminho —
 * `chat.cpp:1386` usa um dict genérico (`p.tool_args(p.ref("gemma4-dict"))`) e a
 * linha que passaria `parameters` está comentada com um TODO. Todos os outros
 * formatos de chat fazem `p.tool_args(p.schema(...))`; Gemma 4 é a exceção.
 * Injetar gramática pelo request não é opção: `response_format`/`json_schema`
 * faz o caminho gemma4 ABANDONAR tool calling (`chat.cpp:1334-1339`) e um
 * `grammar` no corpo é sobrescrito pela gramática do template.
 *
 * Consequência: chaves, tipos, `required` e enums só valem se NÓS validarmos.
 * É o que este módulo faz — schema em zod é o dono, o JSON Schema mandado ao
 * modelo é DERIVADO dele, e `validateToolArgs` roda antes do dispatch.
 * Doutrina 1: gramática/schema cuida do formato, engine cuida do sentido — a
 * validação semântica de `executeTool` (ficha, dataset, orçamento de ações)
 * continua inteira.
 *
 * O template renderiza no prompt apenas `description`, `type`, `enum` (só para
 * STRING) e `items`, mais `required`/`type` do objeto. Ou seja: `enum` CHEGA ao
 * modelo como texto, enquanto `minimum`/`maximum` valem só como validação (custo
 * zero de tokens). Exceção verificada via `POST /apply-template`: dentro de
 * `items` o template despeja TODAS as chaves, então lá o `additionalProperties`
 * aparece — inofensivo, e de resto até útil.
 */
import * as z from "zod/v4";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { ENCOUNTER_DIFFICULTIES, MAX_PARTY_SIZE } from "./combat.js";

/**
 * Custo de ação. 0 é legítimo (save reativo puro), 3 é o teto do turno.
 * `clampActionCost` ainda normaliza o valor aceito; o schema é o que impede um
 * absurdo (`actions: 7`) de virar silenciosamente 3.
 */
const actionCost = z
  .number()
  .int()
  .min(0)
  .max(3)
  .optional()
  .describe(
    "Action cost (1-3) charged for THIS roll. Default 1. Pass the activity's FULL cost when ONE roll resolves it (Sudden Charge = 2, Vicious Swing = 2). Multi-Strike activities (Twin Feint, Double Slice) stay 1 per Strike. Pass 1 for a save that IS an action (e.g. Shake it Off); plain reactive saves cost 0 automatically.",
  );

const rollCheckSchema = z
  .strictObject({
    skill: z
      .string()
      .min(1)
      .describe(
        "What to roll: a skill (e.g. deception, stealth, athletics), a save (fortitude, reflex, will), 'perception', a Lore name, or — for an ATTACK — the weapon/Strike name (e.g. 'dagger'). For an enemy's Strike, any name works; the engine uses the enemy's attack bonus.",
      ),
    dc: z
      .number()
      .int()
      .min(5)
      .optional()
      .describe(
        "The DC for a NON-attack check (very easy 10, easy 15, normal 20, hard 25, very hard 30). For an attack, OMIT this — the engine uses the target's real AC from the combat state.",
      ),
    target: z
      .string()
      .min(1)
      .optional()
      .describe(
        "ATTACKS ONLY: the id or name of the combatant being attacked. When set (and combat is active) this is treated as a Strike by the active combatant against that target, using the target's real AC and applying MAP.",
      ),
    agile: z
      .boolean()
      .optional()
      .describe(
        "ATTACKS ONLY: true if the weapon has the agile trait (MAP -4/-8 instead of -5/-10). For weapons on the character sheet the engine reads the trait from the rules data and IGNORES this — only pass it for weapons the sheet doesn't list (improvised, unarmed).",
      ),
    actions: actionCost,
    reason: z.string().min(1).describe("Short description of what is being attempted."),
  })
  // O erro mais frequente da bateria (6 de 16): nem `dc` nem `target`, que antes
  // caía no guard do `dc ?? 0`. Uma rolagem é ataque (tem `target`) ou tem DC
  // real — nunca nenhum dos dois.
  .refine((v) => v.dc !== undefined || v.target !== undefined, {
    error:
      "A roll needs either a real DC (non-attack check: very easy 10, easy 15, normal 20, hard 25, very hard 30) or a `target` (an attack, which uses the target's real AC). You passed neither — trivial actions and actions against helpless/dead targets simply succeed WITHOUT a roll.",
  });

const spendActionsSchema = z.strictObject({
  actions: z
    .number()
    .int()
    .min(0)
    .max(3)
    .describe("How many actions to spend (1-3)."),
  reason: z
    .string()
    .min(1)
    .describe("What the actions are spent on, e.g. 'Plant Banner (1 action)'."),
});

const useItemSchema = z.strictObject({
  item: z
    .string()
    .min(1)
    .describe(
      "The item's name as listed in Equipment, e.g. 'Healing Potion (Minor)' or \"Alchemist's Fire\".",
    ),
  target: z
    .string()
    .min(1)
    .optional()
    .describe(
      "BOMBS/offensive items only: the id or name of the combatant being targeted.",
    ),
  reason: z.string().min(1).describe("What the character does with the item."),
});

/** Espelha o `switch` de string em `executeTool` (`rest`). */
export const REST_KINDS = ["overnight", "treat_wounds"] as const;

const restSchema = z.strictObject({
  kind: z
    .enum(REST_KINDS)
    .describe(
      "'overnight' for sleeping/camping through the night; 'treat_wounds' for a 10-minute Medicine treatment.",
    ),
  reason: z.string().min(1).optional().describe("What the character does to rest."),
});

const castSpellSchema = z.strictObject({
  spell: z
    .string()
    .min(1)
    .describe("The spell's name as on the sheet, e.g. 'Fireball', 'Ignition'."),
  target: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Offensive single-target spells: the combatant's id or name. Area spells (Fireball) may omit it to hit every enemy.",
    ),
  rank: z
    .number()
    .int()
    .min(1)
    .max(10)
    .optional()
    .describe(
      "Slot rank to cast at, for heightening (spontaneous casters). Defaults to the spell's own rank. Ignored for cantrips (auto-heightened).",
    ),
});

const startCombatSchema = z.strictObject({
  enemies: z
    .array(
      z.strictObject({
        name: z
          .string()
          .min(1)
          .describe(
            "Creature name EXACTLY as it appears in the scene/player's message (e.g. the scene says 'goblin war chanter' → pass 'Goblin War Chanter'; NEVER substitute a similar creature you know, like 'Goblin Warrior'). Real PF2e names get the OFFICIAL statblock (AC/HP/saves/real attacks) and the official level overrides your estimate; invented names get generic level-based stats.",
          ),
        level: z
          .number()
          .int()
          .min(-1)
          .max(25)
          .optional()
          .describe(
            "Creature level — matters only for creatures NOT in the bestiary (unnamed thugs, custom NPCs); official creatures use their real level. Guide: mundane townsperson/clerk/merchant = -1 to 0; trained guard/thug = 1-2; veteran/soldier = 3-4; elite/leader = 5-7; boss/monster = 8+. If omitted, the engine assumes a weak commoner (level 0).",
          ),
        count: z
          .number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .describe("How many of this creature (default 1)."),
      }),
    )
    .min(1)
    .describe("The enemies joining the fight."),
  difficulty: z
    .enum(ENCOUNTER_DIFFICULTIES as unknown as [string, ...string[]])
    .optional()
    .describe(
      "Intended encounter difficulty (default 'moderate'). Use 'severe'/'extreme' ONLY for climactic boss moments. The engine enforces the PF2e XP budget for the REAL party size and trims anything over it — 'extreme' is the hard ceiling.",
    ),
});

const endTurnSchema = z.strictObject({});

const endCombatSchema = z.strictObject({
  reason: z
    .string()
    .min(1)
    .describe("Why the fight is over, e.g. 'enemy surrendered', 'player fled the scene'."),
});

const lookupRuleSchema = z.strictObject({
  query: z.string().min(1).describe("What to look up (the rule's name)."),
});

const getCharacterSchema = z.strictObject({});

const manageCompanionSchema = z.strictObject({
  action: z
    .enum(["join", "leave"])
    .describe(
      "'join' when an NPC becomes a traveling companion of the party; 'leave' when a companion departs, is dismissed, or dies in the story.",
    ),
  name: z
    .string()
    .min(1)
    .describe(
      "The NPC's name as it appears in the scene. A real PF2e creature/NPC name gets its OFFICIAL statblock; an invented name gets honest level-based stats.",
    ),
  level: z
    .number()
    .int()
    .min(-1)
    .max(25)
    .optional()
    .describe(
      "JOIN only, for NPCs NOT in the bestiary. Guide: townsperson = 0; trained guard/hunter = 1-2; veteran = 3-4; elite = 5+. Official creatures use their real level. If omitted, level 0.",
    ),
  persona: z
    .string()
    .min(1)
    .max(300)
    .optional()
    .describe(
      "JOIN only: a SHORT voice sketch for narration (1-2 sentences — temperament, speech style, one quirk). E.g. 'Dry-witted veteran; speaks in clipped sentences; hates being thanked.'",
    ),
});

const updateStateSchema = z.strictObject({
  hpDelta: z
    .number()
    .int()
    .optional()
    .describe("HP change (negative = damage, positive = healing)."),
  addConditions: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Official PF2e condition names. Add the numeric value when the condition takes one, e.g. 'frightened 2', 'clumsy 1', 'persistent fire damage 1d4'.",
    ),
  removeConditions: z
    .array(z.string().min(1))
    .optional()
    .describe("Condition names to remove, e.g. 'off-guard'."),
  target: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Combat only: id/name of the combatant to affect (e.g. apply 'off-guard' to an enemy). Omit to affect the player.",
    ),
});

/** Uma tool: nome, descrição e o schema que é dono dos argumentos. */
export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodType;
}

/**
 * O registro. Ordem preservada (é a ordem em que o modelo lê as declarações).
 *
 * As descrições ficam AQUI e em nenhum outro lugar: era a duplicação que deixou
 * `roll_damage` — uma tool que nunca existiu em `executeTool` — citada em duas
 * descrições, prometendo ao modelo algo que só devolvia `Unknown tool`.
 */
export const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: "roll_check",
    description:
      "Rolls a d20 and returns the PF2e degree of success. Use for skills, saves, Perception, and WEAPON ATTACKS (Strikes). For an attack, pass `target`: the engine uses the target's real AC, applies the Multiple Attack Penalty, and — ON A HIT — automatically rolls and applies damage (doubled on a crit, plus Sneak Attack if the target is off-guard). You do NOT need a separate damage step. Call once per Strike (a multi-Strike activity like Twin Feint = one call per Strike). NEVER state a die result without calling this tool.",
    schema: rollCheckSchema,
  },
  {
    name: "spend_actions",
    description:
      "COMBAT ONLY: spends the player's actions for something that needs NO roll — activities and feats without a check (Plant Banner, Improvised Repair, raising a shield, drawing an item, a Stride without opposition). Every feat/activity with an action cost MUST be paid: if there is no roll_check to charge it, call this. The engine validates against the actions remaining.",
    schema: spendActionsSchema,
  },
  {
    name: "use_item",
    description:
      "Uses/consumes an item from the character's Equipment (potion, elixir, bomb, torch...). The ENGINE verifies the sheet, spends the real quantity, and resolves the real effect: a bomb is thrown as a Strike with the item's REAL statblock (pass `target`); a healing potion heals its listed dice automatically. Costs 2 actions in combat (draw + use). ALWAYS use this tool for items — never spend_actions or update_state.",
    schema: useItemSchema,
  },
  {
    name: "rest",
    description:
      "Rests to recover, with the REAL PF2e rules (the engine computes the healing — NEVER invent HP with update_state). kind 'overnight' = a full night's sleep: heals CON modifier × level HP, restores ALL spell slots and focus points, removes fatigued and reduces drained/doomed by 1. kind 'treat_wounds' = 10 minutes of first aid: Medicine check (requires trained Medicine AND a healer's toolkit in the Equipment) healing 2d8 HP on a success, 4d8 on a critical. ALWAYS call this when the player rests, sleeps, camps, treats wounds, or asks to recover HP outside combat.",
    schema: restSchema,
  },
  {
    name: "cast_spell",
    description:
      "Casts a spell from the character's sheet. The ENGINE validates the spell is known, spends the real spell slot (or focus point; cantrips are free and auto-heightened), charges the cast actions, and resolves the REAL effect from the rules data: spell attack vs the target's AC, or the target's ACTUAL save vs the character's spell DC, with structured damage/healing (heightened by rank). ALWAYS use this tool for spells — never roll_check/spend_actions/update_state.",
    schema: castSpellSchema,
  },
  {
    name: "start_combat",
    description:
      "Begins a combat encounter. Call this ONCE when a fight starts. The engine adds the player, rolls initiative for everyone, and assigns real AC/HP by creature level. After this, resolve turns with roll_check (attacks — damage is automatic on a hit) and end_turn.",
    schema: startCombatSchema,
  },
  {
    name: "end_turn",
    description:
      "Ends the current combat when one side is fully defeated (victory/defeat). The player gets a fresh 3 actions each of their turns automatically, so you only need this to close out a finished fight; otherwise it's a harmless acknowledgement.",
    schema: endTurnSchema,
  },
  {
    name: "end_combat",
    description:
      "Ends the combat encounter WITHOUT a wipe-out: enemies flee, surrender, are spared, or the player disengages and the scene moves on. (Kills close combat automatically — you don't need this for those.) NEVER leave a combat hanging once the story has moved past the fight.",
    schema: endCombatSchema,
  },
  {
    name: "lookup_rule",
    description:
      "Looks up the official text of a PF2e rule by name: action, feat, spell, condition, item/equipment, or monster. Use before applying one of the character's abilities (e.g. 'Bon Mot', 'Sneak Attack') or a condition (e.g. 'Frightened'). Searches the local index, falling back to Archives of Nethys if not found.",
    schema: lookupRuleSchema,
  },
  {
    name: "get_character",
    description: "Returns the player character's full sheet (attributes, skills, saves).",
    schema: getCharacterSchema,
  },
  {
    name: "manage_companion",
    description: `Adds or removes an NPC ally in the PARTY (the player + up to ${MAX_PARTY_SIZE - 1} companions). Call 'join' ONLY when the story has an NPC genuinely joining as a traveling companion (hired, sworn, rescued and coming along) — NEVER for bystanders, shopkeepers, or scene NPCs the player merely talks to. Call 'leave' when a companion departs for good. The ENGINE resolves the companion's real stats (official statblock for known creatures, level benchmark otherwise) and runs their combat turns automatically — you never roll for companions.`,
    schema: manageCompanionSchema,
  },
  {
    name: "update_state",
    description:
      "Records persistent state changes: damage/healing (hpDelta) and conditions gained/removed. Defaults to the player; pass `target` (a combatant id/name) during combat to affect an enemy/ally instead. Strike damage is applied automatically by roll_check — do NOT re-apply it here.",
    schema: updateStateSchema,
  },
];

const BY_NAME = new Map(TOOL_DEFS.map((t) => [t.name, t]));

/** Nomes das tools registradas — a lista que o `switch` de `executeTool` cobre. */
export const TOOL_NAMES: readonly string[] = TOOL_DEFS.map((t) => t.name);

export function toolDef(name: string): ToolDef | undefined {
  return BY_NAME.get(name);
}

/**
 * JSON Schema derivado do zod, no formato que o `tools` da API espera.
 * `$schema` sai fora: o template não o lê e ele só polui o payload.
 */
function jsonSchemaOf(def: ToolDef): Record<string, unknown> {
  const schema = z.toJSONSchema(def.schema, {
    target: "draft-7",
    io: "input",
    // Refinements (o `dc` XOR `target`) não têm representação em JSON Schema;
    // eles vivem na descrição (para o modelo) e no zod (para o enforcement).
    unrepresentable: "any",
  }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/** As declarações de tool mandadas ao modelo, derivadas do registro. */
export function buildTools(): ChatCompletionTool[] {
  return TOOL_DEFS.map((def) => ({
    type: "function" as const,
    function: {
      name: def.name,
      description: def.description,
      parameters: jsonSchemaOf(def),
    },
  }));
}

/** Resultado da validação de argumentos: ou passa tipado, ou traz a correção. */
export type ArgCheck =
  | { ok: true; args: Record<string, unknown> }
  | { ok: false; message: string };

/** Traduz um erro do zod na instrução corretiva que o modelo vai ler. */
function explain(error: z.ZodError, name: string): string {
  const lines = error.issues.map((issue) => {
    const path = issue.path.join(".");
    const where = path ? `\`${path}\`` : "the arguments";
    if (issue.code === "unrecognized_keys") {
      const keys = issue.keys.map((k) => `\`${k}\``).join(", ");
      return `${keys} is not a parameter of ${name}`;
    }
    return `${where}: ${issue.message}`;
  });
  const valid = Object.keys(
    (jsonSchemaOf(BY_NAME.get(name)!).properties as Record<string, unknown>) ?? {},
  );
  const params = valid.length ? valid.join(", ") : "(none)";
  return `REJECTED — NOTHING was applied. ${lines.join("; ")}. Valid parameters for ${name}: ${params}. Fix the arguments and call again.`;
}

/**
 * Valida os argumentos de uma tool call contra o schema dono.
 *
 * Rejeição é sempre auditável e nunca silenciosa: a mensagem volta ao modelo
 * como resultado da tool (o mesmo canal que os erros semânticos já usam) e
 * nada é aplicado ao estado.
 */
export function validateToolArgs(
  name: string,
  args: Record<string, unknown>,
): ArgCheck {
  const def = BY_NAME.get(name);
  if (!def) {
    return {
      ok: false,
      message: `Unknown tool: ${name}. Valid tools: ${TOOL_NAMES.join(", ")}.`,
    };
  }
  const parsed = def.schema.safeParse(args);
  if (!parsed.success) return { ok: false, message: explain(parsed.error, name) };
  return { ok: true, args: parsed.data as Record<string, unknown> };
}
