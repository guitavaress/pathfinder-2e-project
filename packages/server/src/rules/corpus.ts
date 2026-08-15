/**
 * Corpus de fichas GERADO do dataset real — o antídoto para a suíte medir
 * sempre o mesmo personagem.
 *
 * Até 2026-08-15 a suíte inteira rodava sobre três fichas feitas à mão ("Hero",
 * "Sela", "Jão", a maioria com `as unknown as Character` desligando o schema) e
 * um único export real, um Goblin Rogue 5 sem conjuração, sem companheiro e sem
 * foco. Era por isso que cada personagem novo parecia trazer bugs novos: os
 * caminhos que quebravam eram justamente os que a suíte nunca visitava.
 *
 * O gerador é **seeded e determinístico**: mesma seed, mesma ficha. Isso é o que
 * torna a falha reproduzível — sem isso, um teste vermelho seria irrepetível e
 * viraria `skip` na primeira semana.
 *
 * ESTE ARQUIVO NÃO SUBSTITUI AS FIXTURES TRUNCADAS. Fichas parciais provam uma
 * invariante que o corpus não consegue reproduzir: `roll-context.ts` distingue
 * campo AUSENTE (indecidível) de campo VAZIO (falso), e uma ficha gerada sempre
 * tem todos os campos. As duas coisas convivem de propósito.
 */
import type { Ability, Character } from "@pf2e/shared";
import { CharacterSchema } from "@pf2e/shared";
import { categoryRecords, type RuleRecord } from "./dataset.js";

/** PRNG determinístico (mulberry32): mesma seed, mesma sequência. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(r: () => number, xs: readonly T[]): T | undefined {
  return xs.length ? xs[Math.floor(r() * xs.length)] : undefined;
}

function pickMany<T>(r: () => number, xs: readonly T[], n: number): T[] {
  const pool = [...xs];
  const out: T[] = [];
  while (out.length < n && pool.length) {
    out.push(...pool.splice(Math.floor(r() * pool.length), 1));
  }
  return out;
}

const ABILITY_KEYS: Ability[] = ["str", "dex", "con", "int", "wis", "cha"];

const SKILL_LIST = [
  "acrobatics",
  "arcana",
  "athletics",
  "crafting",
  "deception",
  "diplomacy",
  "intimidation",
  "medicine",
  "nature",
  "occultism",
  "performance",
  "religion",
  "society",
  "stealth",
  "survival",
  "thievery",
] as const;

const SKILL_ABILITY: Record<string, Ability> = {
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
};

export interface CorpusOptions {
  seed: number;
  /** 1..20; sorteado quando ausente. */
  level?: number;
}

let cache: {
  feats: RuleRecord[];
  ancestries: RuleRecord[];
  heritages: RuleRecord[];
  backgrounds: RuleRecord[];
  classes: RuleRecord[];
  spells: RuleRecord[];
  weapons: RuleRecord[];
} | null = null;

function pools() {
  if (cache) return cache;
  const equipment = categoryRecords("equipment");
  cache = {
    feats: categoryRecords("feats"),
    ancestries: categoryRecords("ancestries"),
    heritages: categoryRecords("heritages"),
    backgrounds: categoryRecords("backgrounds"),
    classes: categoryRecords("classes"),
    // Só o que é CONJURÁVEL: `spellRecord` indexa apenas docs com bloco de
    // mecânica, e o importador exclui rituais de propósito (não se conjuram em
    // combate). Sortear ritual aqui gerava "magia não encontrada" na auditoria
    // — um falso achado do gerador, não um buraco da engine. Ficha real também
    // não os tem: o Pathbuilder manda rituais em `build.rituals`, que o parser
    // descarta.
    spells: categoryRecords("spells").filter((r) => r.spell),
    // Armas de verdade: o `die` tem de existir, senão a ficha não é jogável.
    weapons: equipment.filter((r) => r.damage?.die && r.weaponCategory),
  };
  return cache;
}

/**
 * Uma ficha jogável montada a partir do dataset REAL.
 *
 * Não é um build LEGAL de PF2e (não checa pré-requisito de feat nem progressão
 * de classe) e não precisa ser: o alvo é a engine aguentar o que a ficha
 * carrega, não validar construção de personagem. Um build ilegal é, aliás, o
 * caso mais duro — e o jogador consegue montar um.
 */
export function makeCorpusCharacter(opts: CorpusOptions): Character {
  const r = rng(opts.seed);
  const p = pools();
  const level = opts.level ?? 1 + Math.floor(r() * 20);

  const abilities = Object.fromEntries(
    ABILITY_KEYS.map((a) => [a, 8 + Math.floor(r() * 11)]),
  ) as Record<Ability, number>;
  const mods = Object.fromEntries(
    ABILITY_KEYS.map((a) => [a, Math.floor((abilities[a] - 10) / 2)]),
  ) as Record<Ability, number>;

  const klass = pick(r, p.classes);
  const ancestry = pick(r, p.ancestries);
  const heritage = pick(r, p.heritages);
  const background = pick(r, p.backgrounds);

  // Feats do nível do personagem para baixo — a quantidade cresce com o nível,
  // como numa ficha real (~2 por nível entre classe, ancestralidade e perícia).
  const eligible = p.feats.filter((f) => (f.level ?? 0) <= level);
  const feats = pickMany(r, eligible, Math.min(20, 2 + level)).map((f) => f.name);

  const skills = Object.fromEntries(
    SKILL_LIST.map((name) => {
      const rank = Math.floor(r() * 5) as 0 | 1 | 2 | 3 | 4;
      const ability = SKILL_ABILITY[name]!;
      return [
        name,
        {
          name,
          ability,
          rank,
          modifier: (rank > 0 ? level + rank * 2 : 0) + mods[ability],
        },
      ];
    }),
  );

  // Números na escala REAL do nível. A primeira versão usava `level + 4 + mod`
  // para tudo, o que num nível 20 dava +25 contra CA 44 do bestiary: o
  // personagem precisava de 19 no dado e a simulação media um boneco sendo
  // massacrado, não uma luta. PF2e no nível 20: proficiência master/legendary
  // (level + 6/8) + runa de potência (+3) + habilidade.
  const profBonus = level >= 15 ? 8 : level >= 7 ? 6 : 4;
  const runeBonus = level >= 16 ? 3 : level >= 10 ? 2 : level >= 2 ? 1 : 0;
  const strikingDice = level >= 19 ? 4 : level >= 12 ? 3 : level >= 4 ? 2 : 1;
  const weaponRecs = pickMany(r, p.weapons, 1 + Math.floor(r() * 2));
  const weapons = weaponRecs.map((w) => ({
    name: w.name,
    attack: level + profBonus + runeBonus + mods.str,
    die: w.damage?.die ?? "d6",
    dice: strikingDice,
    damageBonus: mods.str,
    damageType: "S",
  }));
  // Ficha sem arma nenhuma não é jogável em combate; garante ao menos uma.
  if (weapons.length === 0) {
    weapons.push({
      name: "Fist",
      attack: level + profBonus + runeBonus + mods.str,
      die: "d4",
      dice: 1,
      damageBonus: mods.str,
      damageType: "B",
    });
  }

  // Metade dos personagens conjura — é o que a suíte inteira nunca exercitou.
  const isCaster = r() < 0.5;
  const spellPool = p.spells.filter((s) => (s.level ?? 0) <= Math.ceil(level / 2));
  const known = isCaster ? pickMany(r, spellPool, Math.min(12, 2 + level)) : [];
  const spellcasting = isCaster
    ? [
        {
          name: `${klass?.name ?? "Arcane"} Spellcasting`,
          tradition: "arcane",
          type: r() < 0.5 ? "spontaneous" : "prepared",
          ability: "int",
          attack: level + 4 + mods.int,
          dc: 10 + level + 4 + mods.int,
          spells: known.map((s) => s.name),
          slots: { "1": 3, "2": 2 },
          spellsByRank: {
            "0": known.filter((s) => (s.level ?? 0) === 0).map((s) => s.name),
            "1": known.filter((s) => (s.level ?? 0) === 1).map((s) => s.name),
            "2": known.filter((s) => (s.level ?? 0) === 2).map((s) => s.name),
          },
        },
      ]
    : [];

  const character: Character = {
    name: `Corpus#${opts.seed}`,
    ancestry: ancestry?.name ?? "Human",
    heritage: heritage?.name ?? null,
    background: background?.name ?? "Field Medic",
    className: klass?.name ?? "Fighter",
    level,
    abilities: abilities as Character["abilities"],
    abilityModifiers: mods as Character["abilityModifiers"],
    maxHp: 8 + (8 + mods.con) * level,
    // CA na escala do nível: 10 + proficiência + armadura+runa + Dex (limitado).
    ac: 10 + profBonus + level + Math.min(2 + runeBonus, 5) + Math.min(Math.max(0, mods.dex), 4),
    speed: 25,
    perception: level + profBonus + mods.wis,
    saves: {
      fortitude: level + profBonus + mods.con,
      reflex: level + profBonus + mods.dex,
      will: level + profBonus + mods.wis,
    },
    classDc: 10 + level + profBonus + mods.str,
    acItemBonus: 2,
    weaponProficiencies: { simple: 2, martial: 2 },
    skills,
    lores: [],
    feats,
    classFeatures: [],
    senses: [],
    weapons,
    armor: [],
    equipment: [],
    money: { cp: 0, sp: 0, gp: 10, pp: 0 },
    spellcasting,
    resistances: [],
    languages: ["Common"],
    deity: null,
    alignment: null,
    size: null,
  };

  // Passa pelo MESMO schema que um import real: se o corpus não é uma ficha
  // válida, o teste que ele alimenta não prova nada.
  return CharacterSchema.parse(character);
}

/** N fichas determinísticas a partir de uma seed base. */
export function makeCorpus(baseSeed: number, n: number): Character[] {
  return Array.from({ length: n }, (_, i) => makeCorpusCharacter({ seed: baseSeed + i * 7919 }));
}
