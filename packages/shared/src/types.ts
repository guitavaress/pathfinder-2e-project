import { z } from "zod";

/** Os seis atributos do Pathfinder 2e. */
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
 * As 16 perícias padrão do PF2e e a sua característica-chave.
 * Lores (perícias de conhecimento) são tratadas à parte porque têm nome livre.
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

/** Rank de proficiência: 0 destreinado, 1 treinado, 2 perito, 3 mestre, 4 lendário. */
export const ProficiencyRankSchema = z.union([
  z.literal(0),
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
export type ProficiencyRank = z.infer<typeof ProficiencyRankSchema>;

/** Uma perícia com o seu rank e bônus total já calculado. */
export const SkillSchema = z.object({
  name: z.string(),
  ability: z.enum(ABILITIES),
  rank: ProficiencyRankSchema,
  /** Bônus total: rank*2 + nível (se treinado) + mod de atributo. */
  modifier: z.number().int(),
});
export type Skill = z.infer<typeof SkillSchema>;

export const LoreSchema = z.object({
  name: z.string(),
  rank: ProficiencyRankSchema,
  modifier: z.number().int(),
});
export type Lore = z.infer<typeof LoreSchema>;

/** Uma arma com ataque e dano já calculados pelo Pathbuilder. */
export const WeaponSchema = z.object({
  name: z.string(),
  /** Bônus de ataque total. */
  attack: z.number().int(),
  /** Dado de dano, ex.: "d4". */
  die: z.string(),
  /** Bônus de dano fixo. */
  damageBonus: z.number().int(),
  /** Tipo de dano, ex.: "P", "S", "B". */
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

/** Uma classe de conjuração do personagem (quando houver). */
export const SpellcastingSchema = z.object({
  name: z.string(),
  tradition: z.string(),
  /** "spontaneous" | "prepared" | "innate" | "focus" etc. */
  type: z.string(),
  ability: z.string(),
  attack: z.number().int().nullable(),
  dc: z.number().int().nullable(),
  /** Lista achatada de nomes de magias conhecidas/preparadas. */
  spells: z.array(z.string()),
});
export type Spellcasting = z.infer<typeof SpellcastingSchema>;

/** Personagem normalizado a partir do export do Pathbuilder 2e. */
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
  /** Bônus de item da CA (de armadura/escudo). */
  acItemBonus: z.number().int(),
  skills: z.record(z.string(), SkillSchema),
  lores: z.array(LoreSchema),
  feats: z.array(z.string()),
  /** Traços de classe e habilidades especiais (de `specials`). */
  classFeatures: z.array(z.string()),
  /** Sentidos derivados (Darkvision, Low-Light Vision, etc.). */
  senses: z.array(z.string()),
  weapons: z.array(WeaponSchema),
  armor: z.array(ArmorSchema),
  equipment: z.array(EquipmentItemSchema),
  money: MoneySchema,
  spellcasting: z.array(SpellcastingSchema),
  resistances: z.array(z.string()),
  languages: z.array(z.string()),
  deity: z.string().nullable(),
  alignment: z.string().nullable(),
  size: z.string().nullable(),
});
export type Character = z.infer<typeof CharacterSchema>;

/** Graus de sucesso do PF2e. */
export const DEGREES = [
  "criticalSuccess",
  "success",
  "failure",
  "criticalFailure",
] as const;
export type DegreeOfSuccess = (typeof DEGREES)[number];

export const CheckResultSchema = z.object({
  /** Rótulo da rolagem, ex.: "Deception vs DC 18". */
  label: z.string(),
  die: z.number().int().min(1).max(20),
  modifier: z.number().int(),
  total: z.number().int(),
  dc: z.number().int(),
  degree: z.enum(DEGREES),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

/** Eventos que compõem o registro de uma cena (renderizados na UI). */
export const SceneEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("narration"), text: z.string() }),
  z.object({ type: z.literal("player"), text: z.string() }),
  z.object({ type: z.literal("check"), result: CheckResultSchema }),
]);
export type SceneEvent = z.infer<typeof SceneEventSchema>;

/** Estado mutável de uma sessão de jogo. */
export const GameStateSchema = z.object({
  sessionId: z.string(),
  currentHp: z.number().int(),
  conditions: z.array(z.string()),
  /** Flags livres da história (NPCs conhecidos, escolhas feitas, etc.). */
  flags: z.record(z.string(), z.unknown()),
});
export type GameState = z.infer<typeof GameStateSchema>;
