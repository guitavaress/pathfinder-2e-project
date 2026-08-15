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
describe("runa striking → quantidade de dados de dano", () => {
  const build = (str: unknown) =>
    parsePathbuilder({
      success: true,
      build: {
        name: "T",
        class: "Rogue",
        level: 5,
        abilities: { str: 10, dex: 18, con: 12, int: 10, wis: 10, cha: 10 },
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
