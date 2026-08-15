/**
 * A paleta do jogador (Fase 2.7 / T7.4).
 *
 * O que a UI oferece no `@` tem que ser exatamente o que o portão do
 * `lookup_rule` resolve — as duas coisas leem o mesmo `sheetCategoriesOf`. Se
 * divergirem, a paleta promete uma habilidade e a engine consulta outra.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Character } from "@pf2e/shared";
import { buildPalette } from "./palette.js";
import { lookupForSheet } from "../rules/sheet-lookup.js";
import { parsePathbuilder } from "../pathbuilder/parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));

const BASE = parsePathbuilder(
  JSON.parse(readFileSync(join(here, "../../../../exemplo_personagem.json"), "utf8")) as unknown,
) as Character;

describe.skipIf(!hasGenerated)("buildPalette", () => {
  it("traz os feats da ficha com a categoria e o uuid do dado", () => {
    const entries = buildPalette(BASE);
    const bonMot = entries.find((e) => e.name === "Bon Mot");
    expect(bonMot).toBeDefined();
    expect(bonMot!.category).toBe("feats");
    expect(bonMot!.uuid).toMatch(/^\w+$/);
    expect(bonMot!.group).toBe("ability");
  });

  it("declara o custo de ação vindo do dado, não do palpite", () => {
    const entries = buildPalette({
      ...BASE,
      feats: ["Sudden Charge"],
    } as Character);
    expect(entries.find((e) => e.name === "Sudden Charge")?.cost).toBe("2 actions");
  });

  it("mantém a grafia da FICHA, e a referência não depende dela", () => {
    // O dado grafa "Shake it Off"; a ficha, "Shake It Off". O jogador vê a
    // dele — o que desambigua é a categoria/uuid, não o texto.
    const c = { ...BASE, feats: ["Shake It Off"] } as Character;
    const entry = buildPalette(c).find((e) => e.name === "Shake It Off");
    expect(entry).toBeDefined();
    expect(entry!.category).toBe("feats");
    expect(entry!.uuid).toBeTruthy();
  });

  it("agrupa magia, item e identidade separados das habilidades", () => {
    const c = {
      ...BASE,
      spellcasting: [
        {
          name: "W",
          tradition: "arcane",
          type: "prepared",
          ability: "int",
          attack: 10,
          dc: 20,
          spells: ["Fly"],
        },
      ],
    } as unknown as Character;
    const entries = buildPalette(c);
    expect(entries.find((e) => e.name === "Fly")?.group).toBe("spell");
    expect(entries.find((e) => e.group === "identity")).toBeDefined();
    // Ordenada por grupo: habilidades antes de magias antes de itens.
    const groups = entries.map((e) => e.group);
    expect(groups.indexOf("ability")).toBeLessThan(groups.lastIndexOf("spell"));
  });

  it("nome que a ficha tem e o dado não conhece continua aparecendo, sem uuid", () => {
    const c = { ...BASE, feats: ["Habilidade Caseira do Jão"] } as Character;
    const entry = buildPalette(c).find((e) => e.name === "Habilidade Caseira do Jão");
    expect(entry).toBeDefined();
    expect(entry!.uuid).toBeUndefined();
  });

  it("o que a paleta oferece é o que o portão resolve — mesma fonte", () => {
    const c = { ...BASE, feats: [...BASE.feats, "Shake It Off"] } as Character;
    const entry = buildPalette(c).find((e) => e.name === "Shake It Off")!;
    const hit = lookupForSheet(c, entry.name, {
      ...(entry.uuid ? { ref: entry.uuid } : {}),
      category: entry.category,
    });
    expect(hit.primary!.category).toBe(entry.category);
  });

  it("a arma com runa continua sendo a arma — a paleta descasca o que o dado não grafa", () => {
    // Bug real de play-test: o Pathbuilder exporta o `display` com as runas
    // ("+1 Striking Rapier") e o dataset grafa a base ("Rapier"). Resolvendo
    // com o `lookupInCategory` cru, a paleta perdia o uuid da arma EMPUNHADA
    // e mandava ao `lookup_rule` uma referência mais fraca que a da engine.
    const c = {
      ...BASE,
      weapons: [
        { name: "+1 Striking Rapier", attack: 14, die: "d6", damageBonus: 1, damageType: "P" },
      ],
      armor: [{ name: "Studded Leather", proficiency: "light", worn: true }],
    } as unknown as Character;
    const entries = buildPalette(c);

    const rapier = entries.find((e) => e.name === "+1 Striking Rapier");
    expect(rapier, "a grafia da ficha é preservada").toBeDefined();
    expect(rapier!.uuid, "mas o uuid vem da base do dado").toBeTruthy();

    // "Studded Leather" na ficha × "Studded Leather Armor" no dataset.
    const armor = entries.find((e) => e.name === "Studded Leather");
    expect(armor).toBeDefined();
    expect(armor!.uuid).toBeTruthy();
  });

  it("ficha sem os campos opcionais não explode", () => {
    const partial = { feats: ["Bon Mot"] } as unknown as Character;
    expect(() => buildPalette(partial)).not.toThrow();
    expect(buildPalette(partial).map((e) => e.name)).toContain("Bon Mot");
  });
});
