import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { abilityModifier, parsePathbuilder } from "./parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const examplePath = join(here, "../../../../exemplo_personagem.json");
const example = JSON.parse(readFileSync(examplePath, "utf8"));

describe("abilityModifier", () => {
  it("segue a fórmula floor((score-10)/2)", () => {
    expect(abilityModifier(10)).toBe(0);
    expect(abilityModifier(18)).toBe(4);
    expect(abilityModifier(8)).toBe(-1);
    expect(abilityModifier(7)).toBe(-2);
  });
});

describe("parsePathbuilder com o personagem de exemplo (Goblin Rogue nível 5)", () => {
  const c = parsePathbuilder(example);

  it("extrai a identidade básica", () => {
    expect(c.className).toBe("Rogue");
    expect(c.ancestry).toBe("Goblin");
    expect(c.level).toBe(5);
  });

  it("lê os atributos e modificadores", () => {
    expect(c.abilities.dex).toBe(19);
    expect(c.abilityModifiers.dex).toBe(4); // floor((19-10)/2)
    expect(c.abilityModifiers.cha).toBe(4); // cha 18
    expect(c.abilityModifiers.wis).toBe(-1); // wis 8
  });

  it("calcula CA, HP e deslocamento", () => {
    expect(c.ac).toBe(22);
    expect(c.maxHp).toBe(65); // 6 + (8+3)*5 + 4
    expect(c.speed).toBe(25);
  });

  it("calcula saves e perception (nível + rank*2 + mod)", () => {
    expect(c.saves.reflex).toBe(13); // 5 + 4 (expert) + 4 (dex)
    expect(c.saves.fortitude).toBe(10); // 5 + 2 (trained) + 3 (con)
    expect(c.saves.will).toBe(8); // 5 + 4 (expert) - 1 (wis)
    expect(c.perception).toBe(8); // 5 + 4 (expert) - 1
  });

  it("calcula bônus de perícias treinadas e destreinadas", () => {
    expect(c.skills.stealth!.modifier).toBe(13); // expert: 5 + 4 + 4 (dex)
    expect(c.skills.deception!.modifier).toBe(13); // expert: 5 + 4 + 4 (cha)
    expect(c.skills.medicine!.modifier).toBe(-1); // destreinada: só o mod
    expect(c.skills.medicine!.rank).toBe(0);
  });

  it("calcula a Class DC (10 + nível + rank*2 + key ability)", () => {
    expect(c.classDc).toBe(21); // key dex: 10 + 5 + 2 + 4
  });

  it("lê lores, feats e ignora linguagens não selecionadas", () => {
    expect(c.lores.find((l) => l.name === "Underworld")?.modifier).toBe(9); // 5 + 2 + int 2
    expect(c.feats).toContain("Bon Mot");
    expect(c.feats.length).toBe(13);
    expect(c.languages).toEqual([]);
  });

  it("lê armas com ataque e dano já calculados", () => {
    const dagger = c.weapons.find((w) => w.name === "Dagger");
    expect(dagger).toBeDefined();
    expect(dagger!.attack).toBe(13);
    expect(dagger!.die).toBe("d4");
    expect(dagger!.damageType).toBe("P");
  });

  it("lê armadura e o bônus de item da CA", () => {
    expect(c.armor.find((a) => a.name === "Studded Leather")?.worn).toBe(true);
    expect(c.acItemBonus).toBe(2); // Studded Leather -> CA 22 total
  });

  it("lê equipamento e dinheiro", () => {
    expect(c.equipment.find((e) => e.name === "Backpack")).toBeDefined();
    expect(c.money.gp).toBe(10);
    expect(c.money.sp).toBe(1);
  });

  it("separa traços de classe e sentidos a partir de specials", () => {
    expect(c.classFeatures).toContain("Sneak Attack");
    expect(c.classFeatures).toContain("Scoundrel Racket");
    expect(c.senses).toContain("Darkvision");
    expect(c.classFeatures).not.toContain("Darkvision");
  });

  it("rogue de exemplo não tem conjuração", () => {
    expect(c.spellcasting).toEqual([]);
  });
});
