import {
  type Ability,
  type Character,
  type Lore,
  type ProficiencyRank,
  type Skill,
  ABILITIES,
  CharacterSchema,
  SKILL_ABILITIES,
} from "@pf2e/shared";

/** Modificador de atributo do PF2e: floor((score - 10) / 2). */
export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

/** Pathbuilder grava proficiência como rank*2 (0/2/4/6/8). Converte para rank 0..4. */
function toRank(pathbuilderValue: number | undefined): ProficiencyRank {
  const rank = Math.round((pathbuilderValue ?? 0) / 2);
  return Math.max(0, Math.min(4, rank)) as ProficiencyRank;
}

/**
 * Bônus total de uma proficiência (perícia, save, perception).
 * PF2e: se treinado+, soma nível + rank*2 + mod; se destreinado, soma só o mod.
 */
function proficiencyBonus(
  rank: ProficiencyRank,
  level: number,
  abilityMod: number,
): number {
  const profPart = rank > 0 ? level + rank * 2 : 0;
  return profPart + abilityMod;
}

/** Estrutura mínima do export do Pathbuilder que consumimos. */
interface PathbuilderExport {
  success?: boolean;
  build?: Record<string, unknown>;
}

function asNumber(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/**
 * Converte o JSON exportado pelo Pathbuilder 2e num `Character` normalizado.
 * Lança erro se a estrutura básica não bater.
 */
export function parsePathbuilder(raw: unknown): Character {
  const data = raw as PathbuilderExport;
  const build = data?.build;
  if (!build || typeof build !== "object") {
    throw new Error("JSON do Pathbuilder inválido: campo 'build' ausente.");
  }

  const abilitiesRaw = (build.abilities ?? {}) as Record<string, unknown>;
  const abilities = Object.fromEntries(
    ABILITIES.map((a) => [a, asNumber(abilitiesRaw[a], 10)]),
  ) as Record<Ability, number>;
  const abilityModifiers = Object.fromEntries(
    ABILITIES.map((a) => [a, abilityModifier(abilities[a])]),
  ) as Record<Ability, number>;

  const prof = (build.proficiencies ?? {}) as Record<string, number>;
  const level = asNumber(build.level, 1);
  const attributes = (build.attributes ?? {}) as Record<string, unknown>;

  // Perícias padrão.
  const skills: Record<string, Skill> = {};
  for (const [name, ability] of Object.entries(SKILL_ABILITIES) as [
    keyof typeof SKILL_ABILITIES,
    Ability,
  ][]) {
    const rank = toRank(prof[name]);
    skills[name] = {
      name,
      ability,
      rank,
      modifier: proficiencyBonus(rank, level, abilityModifiers[ability]),
    };
  }

  // Lores (perícias de conhecimento) usam INT.
  const loresRaw = (build.lores ?? []) as [string, number][];
  const lores: Lore[] = loresRaw.map(([name, value]) => {
    const rank = toRank(value);
    return {
      name,
      rank,
      modifier: proficiencyBonus(rank, level, abilityModifiers.int),
    };
  });

  // HP = ancestryhp + (classhp + conMod) * nível + bonushp + bonushpPerLevel * nível.
  const ancestryHp = asNumber(attributes.ancestryhp);
  const classHp = asNumber(attributes.classhp);
  const bonusHp = asNumber(attributes.bonushp);
  const bonusHpPerLevel = asNumber(attributes.bonushpPerLevel);
  const maxHp =
    ancestryHp +
    (classHp + abilityModifiers.con) * level +
    bonusHp +
    bonusHpPerLevel * level;

  const acTotal = (build.acTotal ?? {}) as Record<string, unknown>;

  const keyAbility = asString(build.keyability, "str") as Ability;
  const classDcRank = toRank(prof.classDC);
  const classDc =
    10 +
    proficiencyBonus(classDcRank, level, abilityModifiers[keyAbility] ?? 0);

  const featsRaw = (build.feats ?? []) as unknown[][];
  const feats = featsRaw
    .map((f) => (Array.isArray(f) ? asString(f[0]) : ""))
    .filter((name) => name.length > 0);

  const languagesRaw = (build.languages ?? []) as unknown[];
  const languages = languagesRaw
    .map((l) => asString(l))
    .filter((l) => l && l !== "None selected");

  const perceptionRank = toRank(prof.perception);

  // Armas: ataque e dano já vêm calculados pelo Pathbuilder.
  const weaponsRaw = (build.weapons ?? []) as Record<string, unknown>[];
  const weapons = weaponsRaw.map((w) => ({
    name: asString(w.display, asString(w.name, "Arma")),
    attack: asNumber(w.attack),
    die: asString(w.die),
    damageBonus: asNumber(w.damageBonus),
    damageType: asString(w.damageType),
  }));

  const armorRaw = (build.armor ?? []) as Record<string, unknown>[];
  const armor = armorRaw.map((a) => ({
    name: asString(a.display, asString(a.name, "Armadura")),
    proficiency: asString(a.prof),
    worn: a.worn === true,
  }));

  // Equipamento: arrays no formato [nome, qtd, ...metadados].
  const equipmentRaw = (build.equipment ?? []) as unknown[][];
  const equipment = equipmentRaw
    .filter((e) => Array.isArray(e) && e.length > 0)
    .map((e) => ({ name: asString(e[0]), qty: asNumber(e[1], 1) }))
    .filter((e) => e.name.length > 0);

  const moneyRaw = (build.money ?? {}) as Record<string, unknown>;
  const money = {
    cp: asNumber(moneyRaw.cp),
    sp: asNumber(moneyRaw.sp),
    gp: asNumber(moneyRaw.gp),
    pp: asNumber(moneyRaw.pp),
  };

  // `specials` mistura sentidos e traços de classe; separar por uma lista conhecida.
  const SENSES = new Set([
    "darkvision",
    "greater darkvision",
    "low-light vision",
    "scent",
    "tremorsense",
    "wavesense",
    "lifesense",
    "echolocation",
  ]);
  const specialsRaw = (build.specials ?? []) as unknown[];
  const specials = specialsRaw.map((s) => asString(s)).filter(Boolean);
  const senses = specials.filter((s) => SENSES.has(s.toLowerCase()));
  const classFeatures = specials.filter((s) => !SENSES.has(s.toLowerCase()));

  // Conjuradores (vazio para a maioria dos marciais, como o Rogue de exemplo).
  const castersRaw = (build.spellCasters ?? []) as Record<string, unknown>[];
  const spellcasting = castersRaw.map((c) => {
    const spellsList: string[] = [];
    const groups = (c.spells ?? []) as Record<string, unknown>[];
    for (const g of groups) {
      const list = (g.list ?? g.prepared ?? []) as unknown[];
      for (const sp of list) {
        if (typeof sp === "string") spellsList.push(sp);
        else if (sp && typeof sp === "object")
          spellsList.push(asString((sp as Record<string, unknown>).name));
      }
    }
    return {
      name: asString(c.name, "Conjuração"),
      tradition: asString(c.magicTradition),
      type: asString(c.spellcastingType),
      ability: asString(c.ability),
      attack: c.attack != null ? asNumber(c.attack) : null,
      dc: c.dc != null ? asNumber(c.dc) : null,
      spells: spellsList.filter(Boolean),
    };
  });

  const resistances = ((build.resistances ?? []) as unknown[])
    .map((r) => asString(r))
    .filter(Boolean);

  const character: Character = {
    name: asString(build.name, "Aventureiro"),
    ancestry: asString(build.ancestry),
    heritage: build.heritage ? asString(build.heritage) : null,
    background: asString(build.background),
    className: asString(build.class),
    level,
    abilities: abilities as Character["abilities"],
    abilityModifiers: abilityModifiers as Character["abilityModifiers"],
    maxHp,
    ac: asNumber(acTotal.acTotal),
    speed: asNumber(attributes.speed) + asNumber(attributes.speedBonus),
    perception: proficiencyBonus(perceptionRank, level, abilityModifiers.wis),
    saves: {
      fortitude: proficiencyBonus(
        toRank(prof.fortitude),
        level,
        abilityModifiers.con,
      ),
      reflex: proficiencyBonus(toRank(prof.reflex), level, abilityModifiers.dex),
      will: proficiencyBonus(toRank(prof.will), level, abilityModifiers.wis),
    },
    classDc,
    acItemBonus: asNumber(acTotal.acItemBonus),
    skills,
    lores,
    feats,
    classFeatures,
    senses,
    weapons,
    armor,
    equipment,
    money,
    spellcasting,
    resistances,
    languages,
    deity: build.deity && build.deity !== "Not set" ? asString(build.deity) : null,
    alignment: build.alignment ? asString(build.alignment) : null,
    size: build.sizeName ? asString(build.sizeName) : null,
  };

  return CharacterSchema.parse(character);
}
