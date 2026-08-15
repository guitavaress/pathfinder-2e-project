import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { abilityModifier, parsePathbuilder } from "./parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const examplePath = join(here, "../../../../exemplo_personagem.json");
const example = JSON.parse(readFileSync(examplePath, "utf8"));

describe("abilityModifier", () => {
  it("follows the formula floor((score-10)/2)", () => {
    expect(abilityModifier(10)).toBe(0);
    expect(abilityModifier(18)).toBe(4);
    expect(abilityModifier(8)).toBe(-1);
    expect(abilityModifier(7)).toBe(-2);
  });
});

describe("parsePathbuilder with the example character (Goblin Rogue level 5)", () => {
  const c = parsePathbuilder(example);

  it("extracts the basic identity", () => {
    expect(c.className).toBe("Rogue");
    expect(c.ancestry).toBe("Goblin");
    expect(c.level).toBe(5);
  });

  it("reads abilities and modifiers", () => {
    expect(c.abilities.dex).toBe(19);
    expect(c.abilityModifiers.dex).toBe(4); // floor((19-10)/2)
    expect(c.abilityModifiers.cha).toBe(4); // cha 18
    expect(c.abilityModifiers.wis).toBe(-1); // wis 8
  });

  it("computes AC, HP and speed", () => {
    expect(c.ac).toBe(22);
    expect(c.maxHp).toBe(65); // 6 + (8+3)*5 + 4
    expect(c.speed).toBe(25);
  });

  it("computes saves and perception (level + rank*2 + mod)", () => {
    expect(c.saves.reflex).toBe(13); // 5 + 4 (expert) + 4 (dex)
    expect(c.saves.fortitude).toBe(10); // 5 + 2 (trained) + 3 (con)
    expect(c.saves.will).toBe(8); // 5 + 4 (expert) - 1 (wis)
    expect(c.perception).toBe(8); // 5 + 4 (expert) - 1
  });

  it("computes trained and untrained skill bonuses", () => {
    expect(c.skills.stealth!.modifier).toBe(13); // expert: 5 + 4 + 4 (dex)
    expect(c.skills.deception!.modifier).toBe(13); // expert: 5 + 4 + 4 (cha)
    expect(c.skills.medicine!.modifier).toBe(-1); // untrained: only the mod
    expect(c.skills.medicine!.rank).toBe(0);
  });

  it("computes the Class DC (10 + level + rank*2 + key ability)", () => {
    expect(c.classDc).toBe(21); // key dex: 10 + 5 + 2 + 4
  });

  it("reads lores, feats and ignores unselected languages", () => {
    expect(c.lores.find((l) => l.name === "Underworld")?.modifier).toBe(9); // 5 + 2 + int 2
    expect(c.feats).toContain("Bon Mot");
    expect(c.feats.length).toBe(13);
    expect(c.languages).toEqual([]);
  });

  it("reads weapons with precomputed attack and damage", () => {
    const dagger = c.weapons.find((w) => w.name === "Dagger");
    expect(dagger).toBeDefined();
    expect(dagger!.attack).toBe(13);
    expect(dagger!.die).toBe("d4");
    expect(dagger!.damageType).toBe("P");
  });

  it("reads armor and the AC item bonus", () => {
    expect(c.armor.find((a) => a.name === "Studded Leather")?.worn).toBe(true);
    expect(c.acItemBonus).toBe(2); // Studded Leather -> AC 22 total
  });

  it("reads equipment and money", () => {
    expect(c.equipment.find((e) => e.name === "Backpack")).toBeDefined();
    expect(c.money.gp).toBe(10);
    expect(c.money.sp).toBe(1);
  });

  it("splits class features and senses from specials", () => {
    expect(c.classFeatures).toContain("Sneak Attack");
    expect(c.classFeatures).toContain("Scoundrel Racket");
    expect(c.senses).toContain("Darkvision");
    expect(c.classFeatures).not.toContain("Darkvision");
  });

  it("example rogue has no spellcasting", () => {
    expect(c.spellcasting).toEqual([]);
  });
});

/**
 * A runa striking multiplica os DADOS de dano, e o Pathbuilder nunca embute
 * isso no `die` — ele manda o dado base e a runa separada, no campo `str`.
 * Bug real de play-test: um "+1 Striking Rapier" rolava 1d6 em vez de 2d6.
 */
/**
 * Campo mecânico ausente é ERRO DE IMPORT, não zero.
 *
 * O parser usava `asNumber(v, 0)` em tudo. Um export com campo renomeado ou
 * truncado importava "com sucesso" e o personagem entrava em jogo com CA 0 —
 * todo ataque inimigo virando crítico automático — ou 0 HP, ou uma arma sem
 * dado que `parseDie("")` transformava num d6 fabricado. Falhar é ruidoso e
 * recuperável; jogar com CA 0 não é.
 */
describe("piso numérico do import", () => {
  const valido = {
    name: "T",
    class: "Fighter",
    level: 3,
    abilities: { str: 18, dex: 12, con: 14, int: 10, wis: 10, cha: 10 },
    attributes: { ancestryhp: 8, classhp: 10, bonushp: 0, bonushpPerLevel: 0 },
    acTotal: { acTotal: 19, acItemBonus: 4 },
    keyability: "str",
    weapons: [
      { name: "Longsword", display: "Longsword", die: "d8", attack: 11, damageBonus: 4, damageType: "S" },
    ],
  };
  const semCampo = (drop: (b: Record<string, any>) => void) => {
    const build = structuredClone(valido) as Record<string, any>;
    drop(build);
    return () => parsePathbuilder({ success: true, build });
  };

  it("a fixture de controle importa (a rede não apertou demais)", () => {
    const c = parsePathbuilder({ success: true, build: structuredClone(valido) });
    expect(c.ac).toBe(19);
    expect(c.maxHp).toBe(8 + (10 + 2) * 3);
  });

  it("sem acTotal: rejeita em vez de importar com CA 0", () => {
    expect(semCampo((b) => delete b.acTotal)).toThrow(/acTotal\.acTotal/);
  });

  it("sem ancestryhp/classhp: rejeita em vez de importar com 0 HP", () => {
    expect(semCampo((b) => delete b.attributes.ancestryhp)).toThrow(/ancestryhp/);
    expect(semCampo((b) => delete b.attributes.classhp)).toThrow(/classhp/);
  });

  it("arma sem dado de dano: rejeita em vez de fabricar um d6", () => {
    // `parseDie("")` devolve 6 — a arma sem `die` rolava d6 e nada dizia isso.
    expect(semCampo((b) => delete b.weapons[0].die)).toThrow(/sem dado de dano/);
    expect(semCampo((b) => (b.weapons[0].die = ""))).toThrow(/sem dado de dano/);
  });

  it("arma sem bônus de ataque: rejeita em vez de virar +0", () => {
    expect(semCampo((b) => delete b.weapons[0].attack)).toThrow(/attack/);
  });

  it("keyability inválida: rejeita em vez de corromper a Class DC calada", () => {
    // Antes: `abilityModifiers[keyAbility]` era undefined, o `?? 0` engolia, e
    // a Class DC saía sem o modificador da habilidade-chave.
    expect(semCampo((b) => (b.keyability = "strength"))).toThrow(/keyability/);
  });

  it("bônus OPCIONAIS seguem com default 0 (não viraram obrigatórios)", () => {
    const c = parsePathbuilder({
      success: true,
      build: (() => {
        const b = structuredClone(valido) as Record<string, any>;
        delete b.attributes.bonushp;
        delete b.attributes.bonushpPerLevel;
        delete b.weapons[0].damageBonus;
        return b;
      })(),
    });
    expect(c.maxHp).toBe(8 + (10 + 2) * 3);
    expect(c.weapons[0]!.damageBonus).toBe(0);
  });
});

describe("runa striking → quantidade de dados de dano", () => {
  // `attributes` e `acTotal` entraram aqui em 2026-08-15: o parser passou a
  // exigir os campos que DEFINEM HP e CA, porque `asNumber(v, 0)` fazia um
  // export truncado importar com CA 0 (todo ataque inimigo vira crítico) sem
  // uma linha de aviso. A fixture antes era válida só porque o parser era
  // permissivo — que é o padrão que essa mudança existe para acabar.
  const build = (str: unknown) =>
    parsePathbuilder({
      success: true,
      build: {
        name: "T",
        class: "Rogue",
        level: 5,
        abilities: { str: 10, dex: 18, con: 12, int: 10, wis: 10, cha: 10 },
        attributes: { ancestryhp: 8, classhp: 8, bonushp: 0, bonushpPerLevel: 0 },
        acTotal: { acTotal: 21, acItemBonus: 2 },
        weapons: [
          { name: "Rapier", display: "Rapier", die: "d6", str, attack: 14, damageBonus: 1, damageType: "P" },
        ],
      },
    }).weapons[0]!;

  it("arma sem runa rola 1 dado", () => {
    expect(build("").dice).toBe(1);
    expect(build(null).dice).toBe(1);
    expect(build(undefined).dice).toBe(1);
  });

  it("striking = 2, greater = 3, major = 4", () => {
    expect(build("striking").dice).toBe(2);
    expect(build("greaterStriking").dice).toBe(3);
    expect(build("majorStriking").dice).toBe(4);
  });

  it("a grafia do export não muda o resultado", () => {
    // "greaterStriking" e "greater striking" aparecem os dois na natureza.
    expect(build("greater striking").dice).toBe(3);
    expect(build("Major Striking").dice).toBe(4);
  });

  it("runa desconhecida cai em 1 dado, não inventa dano", () => {
    expect(build("mitalquevoceinventou").dice).toBe(1);
  });

  it("o dado BASE continua vindo do `die`, não da runa", () => {
    const w = build("striking");
    expect(w.die).toBe("d6");
    expect(w.dice).toBe(2); // 2d6, não d12
  });
});
