import { z } from "zod";

/** The six Pathfinder 2e ability scores. */
export const ABILITIES = ["str", "dex", "con", "int", "wis", "cha"] as const;
export type Ability = (typeof ABILITIES)[number];

export const AbilityScoresSchema = z.object({
  str: z.number().int(),
  dex: z.number().int(),
  con: z.number().int(),
  int: z.number().int(),
  wis: z.number().int(),
  cha: z.number().int(),
});
export type AbilityScores = z.infer<typeof AbilityScoresSchema>;

/**
 * The 16 standard PF2e skills and their key ability.
 * Lores (knowledge skills) are handled separately because they have free-form names.
 */
export const SKILL_ABILITIES = {
  acrobatics: "dex",
  arcana: "int",
  athletics: "str",
  crafting: "int",
  deception: "cha",
  diplomacy: "cha",
  intimidation: "cha",
  medicine: "wis",
  nature: "wis",
  occultism: "int",
  performance: "cha",
  religion: "wis",
  society: "int",
  stealth: "dex",
  survival: "wis",
  thievery: "dex",
} as const satisfies Record<string, Ability>;

export type SkillName = keyof typeof SKILL_ABILITIES;
export const SKILL_NAMES = Object.keys(SKILL_ABILITIES) as SkillName[];

/** The three saving throws. Keys of `CharacterSchema.saves`/`CombatantSchema.saves`. */
export const SAVE_NAMES = ["fortitude", "reflex", "will"] as const;
export type SaveName = (typeof SAVE_NAMES)[number];

/** Proficiency rank: 0 untrained, 1 trained, 2 expert, 3 master, 4 legendary. */
export const ProficiencyRankSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type ProficiencyRank = z.infer<typeof ProficiencyRankSchema>;

/** A skill with its rank and precomputed total bonus. */
export const SkillSchema = z.object({
  name: z.string(),
  ability: z.enum(ABILITIES),
  rank: ProficiencyRankSchema,
  /** Total bonus: rank*2 + level (if trained) + ability mod. */
  modifier: z.number().int(),
});
export type Skill = z.infer<typeof SkillSchema>;

export const LoreSchema = z.object({
  name: z.string(),
  rank: ProficiencyRankSchema,
  modifier: z.number().int(),
});
export type Lore = z.infer<typeof LoreSchema>;

/** A weapon with attack and damage precomputed by Pathbuilder. */
export const WeaponSchema = z.object({
  name: z.string(),
  /** Total attack bonus. */
  attack: z.number().int(),
  /** Damage die, e.g. "d4". */
  die: z.string(),
  /**
   * How many damage dice the weapon rolls — a striking rune adds dice
   * (striking 2, greater 3, major 4). `default(1)` porque save.json antigo
   * não tem o campo: ficha sem runa continua rolando 1 dado.
   */
  dice: z.number().int().min(1).default(1),
  /** Flat damage bonus. */
  damageBonus: z.number().int(),
  /** Damage type, e.g. "P", "S", "B". */
  damageType: z.string(),
});
export type Weapon = z.infer<typeof WeaponSchema>;

export const ArmorSchema = z.object({
  name: z.string(),
  proficiency: z.string(),
  worn: z.boolean(),
});
export type Armor = z.infer<typeof ArmorSchema>;

export const EquipmentItemSchema = z.object({
  name: z.string(),
  qty: z.number().int(),
});
export type EquipmentItem = z.infer<typeof EquipmentItemSchema>;

export const MoneySchema = z.object({
  cp: z.number().int(),
  sp: z.number().int(),
  gp: z.number().int(),
  pp: z.number().int(),
});
export type Money = z.infer<typeof MoneySchema>;

/** A character's spellcasting class (when present). */
export const SpellcastingSchema = z.object({
  name: z.string(),
  tradition: z.string(),
  /** "spontaneous" | "prepared" | "innate" | "focus" etc. */
  type: z.string(),
  ability: z.string(),
  attack: z.number().int().nullable(),
  dc: z.number().int().nullable(),
  /** Flattened list of known/prepared spell names. */
  spells: z.array(z.string()),
  /** Slots per day by rank ("1".."10") — cantrips ("0") are unlimited. */
  slots: z.record(z.string(), z.number().int()).optional(),
  /** Known/prepared spell names grouped by rank ("0" = cantrips). */
  spellsByRank: z.record(z.string(), z.array(z.string())).optional(),
});
export type Spellcasting = z.infer<typeof SpellcastingSchema>;

/** Character normalized from the Pathbuilder 2e export. */
export const CharacterSchema = z.object({
  name: z.string(),
  ancestry: z.string(),
  heritage: z.string().nullable(),
  background: z.string(),
  className: z.string(),
  level: z.number().int().min(1).max(20),
  abilities: AbilityScoresSchema,
  abilityModifiers: AbilityScoresSchema,
  maxHp: z.number().int(),
  ac: z.number().int(),
  speed: z.number().int(),
  perception: z.number().int(),
  saves: z.object({
    fortitude: z.number().int(),
    reflex: z.number().int(),
    will: z.number().int(),
  }),
  classDc: z.number().int(),
  /** AC item bonus (from armor/shield). */
  acItemBonus: z.number().int(),
  /** Weapon proficiency ranks (0-4) — drives bomb/improvised attack math. */
  weaponProficiencies: z
    .object({
      simple: ProficiencyRankSchema,
      martial: ProficiencyRankSchema,
    })
    .optional(),
  skills: z.record(z.string(), SkillSchema),
  lores: z.array(LoreSchema),
  feats: z.array(z.string()),
  /** Class features and special abilities (from `specials`). */
  classFeatures: z.array(z.string()),
  /** Derived senses (Darkvision, Low-Light Vision, etc.). */
  senses: z.array(z.string()),
  weapons: z.array(WeaponSchema),
  armor: z.array(ArmorSchema),
  equipment: z.array(EquipmentItemSchema),
  money: MoneySchema,
  spellcasting: z.array(SpellcastingSchema),
  /** Focus pool maximum (0/absent = no focus spells). */
  focusPoints: z.number().int().optional(),
  resistances: z.array(z.string()),
  languages: z.array(z.string()),
  deity: z.string().nullable(),
  alignment: z.string().nullable(),
  size: z.string().nullable(),
});
export type Character = z.infer<typeof CharacterSchema>;

/** PF2e degrees of success. */
export const DEGREES = [
  "criticalSuccess",
  "success",
  "failure",
  "criticalFailure",
] as const;
export type DegreeOfSuccess = (typeof DEGREES)[number];

/** Attack-specific context attached to a Strike's roll (null for plain checks). */
export const AttackContextSchema = z.object({
  attacker: z.string(),
  target: z.string(),
  /** Whoever swung — lets the UI tell "you hit" from "you got hit". */
  attackerKind: z.enum(["player", "ally", "enemy"]),
  outcome: z.enum(["hit", "criticalHit", "miss", "criticalMiss"]),
  /** Damage dealt on a hit (null on a miss). */
  damage: z.number().int().nullable(),
  damageType: z.string().nullable(),
});
export type AttackContext = z.infer<typeof AttackContextSchema>;

export const CheckResultSchema = z.object({
  /** Roll label, e.g. "Deception vs DC 18". */
  label: z.string(),
  die: z.number().int().min(1).max(20),
  modifier: z.number().int(),
  total: z.number().int(),
  /** The number the roll was against — a DC for checks, the target's AC for attacks. */
  dc: z.number().int(),
  degree: z.enum(DEGREES),
  /** Present when this roll is a weapon Strike, so the UI can render it richly. */
  attack: AttackContextSchema.nullable().optional(),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

/** Events that make up a scene's log (rendered in the UI). */
export const SceneEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("narration"), text: z.string() }),
  z.object({ type: z.literal("player"), text: z.string() }),
  z.object({ type: z.literal("check"), result: CheckResultSchema }),
]);
export type SceneEvent = z.infer<typeof SceneEventSchema>;

/** Resistência/fraqueza do statblock: tipo de dano + valor ("fire 5"). */
export const TypedDefenseSchema = z.object({
  type: z.string(),
  value: z.number().int(),
});
export type TypedDefense = z.infer<typeof TypedDefenseSchema>;

/**
 * An NPC ally traveling with the player (ADR-004). The MECHANICAL half lives
 * here: stats resolved at recruit time (bestiary statblock or level benchmark)
 * so they never drift if the dataset changes underneath. The NARRATIVE half is
 * `persona` — a short voice sketch injected one-at-a-time by the voice gate.
 */
export const CompanionSchema = z.object({
  id: z.string(),
  name: z.string(),
  level: z.number().int(),
  ac: z.number().int(),
  maxHp: z.number().int(),
  /** Persists BETWEEN combats — a wounded companion stays wounded. */
  currentHp: z.number().int(),
  perception: z.number().int(),
  conditions: z.array(z.string()),
  traits: z.array(z.string()),
  /** Short voice/personality sketch used by the narrative voice gate. */
  persona: z.string(),
  /** Canonical bestiary record name when built from a real statblock —
   *  lets the engine re-resolve attacks/spellcasting, same as enemies. */
  sourceName: z.string().optional(),
  saves: z
    .object({
      fortitude: z.number().int(),
      reflex: z.number().int(),
      will: z.number().int(),
    })
    .optional(),
  /** Defesas tipadas do statblock, congeladas no recrutamento junto com o resto. */
  immunities: z.array(z.string()).optional(),
  weaknesses: z.array(TypedDefenseSchema).optional(),
  resistances: z.array(TypedDefenseSchema).optional(),
});
export type Companion = z.infer<typeof CompanionSchema>;

/** A participant in a combat encounter (the player, an ally, or an enemy). */
export const CombatantSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["player", "ally", "enemy"]),
  initiative: z.number().int(),
  ac: z.number().int(),
  maxHp: z.number().int(),
  currentHp: z.number().int(),
  /** Conditions with values, e.g. "frightened 1", "off-guard". */
  conditions: z.array(z.string()),
  /** Actions left in this combatant's current turn (0-3). */
  actionsRemaining: z.number().int(),
  /** Whether the reaction is still available this round. */
  reactionAvailable: z.boolean(),
  /** Strikes already made this turn → MAP: 0 = -0, 1 = -5, 2+ = -10. */
  mapProgress: z.number().int(),
  /** Creature level (null for the player / unknown). */
  level: z.number().int().nullable(),
  traits: z.array(z.string()),
  defeated: z.boolean(),
  /** Canonical bestiary record name when built from a real statblock — the
   *  stable key the engine uses to re-resolve attacks (name gets " 1"/" 2"). */
  sourceName: z.string().optional(),
  /** Real saves (bestiary statblock) — spell saves (PR4) and audit lines. */
  saves: z
    .object({
      fortitude: z.number().int(),
      reflex: z.number().int(),
      will: z.number().int(),
    })
    .optional(),
  /** Imunidade/fraqueza/resistência a dano (statblock oficial ou ficha).
   *  Opcionais: saves antigos, gravados antes da Fase 2.5, seguem carregando. */
  immunities: z.array(z.string()).optional(),
  weaknesses: z.array(TypedDefenseSchema).optional(),
  resistances: z.array(TypedDefenseSchema).optional(),
});
export type Combatant = z.infer<typeof CombatantSchema>;

/** Active combat encounter (null when the party is not in combat). */
export const CombatSchema = z.object({
  active: z.boolean(),
  round: z.number().int(),
  /** Index into `combatants` (initiative order) whose turn it is. */
  turnIndex: z.number().int(),
  /** Combatants sorted by initiative (highest first). */
  combatants: z.array(CombatantSchema),
});
export type Combat = z.infer<typeof CombatSchema>;

/**
 * Um efeito ativo no personagem (Fase 2.6).
 *
 * O `effects.json` do dado tem 2.815 docs, 2.674 deles carregando rule elements
 * — 1.949 `FlatModifier`, 378 `Resistance`, 308 `DamageDice` — e **todos** com
 * duração estruturada. É por aqui que `self:effect:<slug>` passa a ser
 * decidível e que bônus temporários entram na conta sem risco de duplo-cômputo:
 * um efeito é temporário, então nunca está embutido no export do Pathbuilder.
 *
 * O registro guarda a duração em vez de um prazo já calculado porque a engine
 * só sabe converter em rodadas quando há combate — fora dele o prazo é o
 * próximo descanso, e isso é decidido na expiração, não na concessão.
 */
export const ActiveEffectSchema = z.object({
  /** Slug do doc sem o prefixo "Effect: " — o que `self:effect:<slug>` casa. */
  slug: z.string(),
  /** Nome exato do doc no dataset ("Effect: Rage"): a chave para reler os REs. */
  name: z.string(),
  /** Ação, feat ou magia que concedeu — auditoria e voz do narrador. */
  source: z.string(),
  /** Unidade de duração, verbatim do dado. */
  unit: z.enum(["rounds", "minutes", "hours", "days", "encounter", "unlimited"]),
  /** Valor da duração; -1 quando o dado não dá prazo (`unlimited`/`encounter`). */
  value: z.number().int(),
  /** Rodada de combate em que expira — só quando a engine SABE decidir (null
   *  fora de combate: aí o prazo é o descanso). */
  expiresOnRound: z.number().int().nullable(),
});
export type ActiveEffect = z.infer<typeof ActiveEffectSchema>;

/** Mutable state of a game session. */
export const GameStateSchema = z.object({
  sessionId: z.string(),
  currentHp: z.number().int(),
  conditions: z.array(z.string()),
  /** Free-form story flags (known NPCs, choices made, etc.). */
  flags: z.record(z.string(), z.unknown()),
  /** Present only during a combat encounter; null otherwise. */
  combat: CombatSchema.nullable(),
  /** Spell slots spent today, by rank ("1".."10"). Restored on daily rest. */
  spellSlotsUsed: z.record(z.string(), z.number().int()).optional(),
  /** Focus points spent (max = character.focusPoints). Refocus restores 1. */
  focusPointsUsed: z.number().int().optional(),
  /** NPC allies traveling with the player. Optional for save compat (v1 saves
   *  predate companions); absent means none. */
  companions: z.array(CompanionSchema).optional(),
  /** Efeitos ativos no JOGADOR. Opcional para compat de save (saves anteriores
   *  à Fase 2.6 não têm o campo); ausente significa nenhum. Efeitos em
   *  inimigos/aliados são dívida declarada — ver ADR-009. */
  effects: z.array(ActiveEffectSchema).optional(),
});
export type GameState = z.infer<typeof GameStateSchema>;

/**
 * Referência EXPLÍCITA a um documento do dataset, anexada ao turno (Fase 2.7).
 *
 * É o que a paleta da UI manda quando o jogador escolhe uma habilidade da
 * própria ficha em vez de digitar o nome solto. Sem isto, um nome colidido
 * ("Shake It Off": reação em `actions` E feat em `feats`, textos diferentes)
 * depende de o índice adivinhar. Com isto não há adivinhação — e a garantia é
 * da ENGINE, não do prompt: a referência não trafega como prosa para o modelo
 * reproduzir, ela fica fixada no turno e o `lookup_rule` a consulta primeiro.
 */
export const TurnRefSchema = z.object({
  /** Nome exibido, como aparece na ficha e no texto do jogador. */
  name: z.string().min(1),
  /** Categoria do dataset ("feats", "spells", "equipment"…). */
  category: z.string().min(1),
  /** uuid do documento, quando conhecido — a forma mais forte. */
  uuid: z.string().optional(),
});
export type TurnRef = z.infer<typeof TurnRefSchema>;
