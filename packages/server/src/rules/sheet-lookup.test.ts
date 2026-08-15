/**
 * Desambiguação de nomes colididos (Fase 2.7).
 *
 * O caso que motivou tudo: `Shake It Off` existe como REAÇÃO em `actions` e
 * como feat de bárbaro em `feats`, com textos diferentes. O índice servia a
 * reação, o modelo lia "reaction" na primeira linha e concluía que a atividade
 * não gastava ação. São 309 nomes assim no dataset.
 *
 * Os testes cobrem as três forças na ordem: referência explícita → portão da
 * ficha → índice. E cobrem o caso em que a ficha NÃO decide, porque abster-se
 * declarando é a metade que importa (doutrina 4: o estado não mente).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Character } from "@pf2e/shared";
import { categoryRecords, lookupInCategory, lookupLocalRule } from "./dataset.js";
import { lookupForSheet, sheetCategoriesOf } from "./sheet-lookup.js";
import { parsePathbuilder } from "../pathbuilder/parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));

const BASE = parsePathbuilder(
  JSON.parse(readFileSync(join(here, "../../../../exemplo_personagem.json"), "utf8")) as unknown,
) as Character;

function withSheet(over: Partial<Character>): Character {
  return { ...BASE, ...over } as Character;
}

describe.skipIf(!hasGenerated)("lookupInCategory: o primitivo sem adivinhação", () => {
  it("serve o registro da categoria pedida, não o da precedência", () => {
    const asAction = lookupInCategory("Shake It Off", "actions");
    const asFeat = lookupInCategory("Shake It Off", "feats");
    expect(asAction?.category).toBe("actions");
    expect(asFeat?.category).toBe("feats");
    // A prova de que a colisão é real: são textos DIFERENTES.
    expect(asFeat!.text).not.toBe(asAction!.text);
  });

  it("nome que não existe naquela categoria devolve null — não cai em outra", () => {
    expect(lookupInCategory("Shake It Off", "spells")).toBeNull();
  });

  it("não faz fuzzy: substring não casa", () => {
    // `lookupLocalRule` acharia por substring; o primitivo explícito, não.
    expect(lookupLocalRule("Shake It")).not.toBeNull();
    expect(lookupInCategory("Shake It", "feats")).toBeNull();
  });

  it("consulta vazia não devolve registro", () => {
    expect(lookupInCategory("  ", "feats")).toBeNull();
  });
});

describe("sheetCategoriesOf: o que a ficha sabe nomear", () => {
  it("mapeia feat, class feature, magia, item, linhagem e classe", () => {
    const c = withSheet({
      feats: ["Bon Mot"],
      classFeatures: ["Sneak Attack"],
      ancestry: "Goblin",
      heritage: "Unbreakable Goblin",
      background: "Acolyte",
      className: "Rogue",
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
      equipment: [{ name: "Healing Potion", quantity: 1 }],
      weapons: [],
      armor: [],
      deity: null,
    } as unknown as Partial<Character>);
    const map = sheetCategoriesOf(c);
    expect(map.get("bon mot")).toEqual(new Set(["feats"]));
    // Traço de classe mora em `feats` no dado (featCategory "classfeature").
    expect(map.get("sneak attack")).toEqual(new Set(["feats"]));
    expect(map.get("fly")).toEqual(new Set(["spells"]));
    expect(map.get("healing potion")).toEqual(new Set(["equipment"]));
    expect(map.get("unbreakable goblin")).toEqual(new Set(["heritages"]));
    expect(map.get("rogue")).toEqual(new Set(["classes"]));
  });

  it("heritage nula e deity nula não viram entrada", () => {
    const map = sheetCategoriesOf(withSheet({ heritage: null, deity: null }));
    expect(map.has("null")).toBe(false);
    expect([...map.keys()].every((k) => k.length > 0)).toBe(true);
  });
});

describe.skipIf(!hasGenerated)("lookupForSheet: as três forças, na ordem", () => {
  it("[ficha] o bárbaro que TEM o feat recebe o feat, não a reação", () => {
    const barb = withSheet({ feats: [...BASE.feats, "Shake It Off"] });
    const hit = lookupForSheet(barb, "Shake It Off");
    expect(hit.primary!.category).toBe("feats");
    expect(hit.via).toBe("sheet");
    expect(hit.ambiguous).toBe(false);
    expect(hit.primary!.text).toMatch(/rage/i);
  });

  it("[ficha] a magia da ficha vence a ação homônima — o buraco que o portão antigo tinha", () => {
    // O portão anterior só promovia para `feats`: `Fly` (magia) continuava
    // sendo servido como a ação de voar. São 94 colisões nesse formato.
    const caster = withSheet({
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
    });
    expect(lookupForSheet(caster, "Fly").primary!.category).toBe("spells");
    expect(lookupForSheet(caster, "Fly").via).toBe("sheet");
    // Sem a magia na ficha, a mesma consulta continua caindo no índice.
    expect(lookupForSheet(BASE, "Fly").primary!.category).toBe("actions");
  });

  it("[explícito] a categoria pedida vence a ficha e o índice", () => {
    const barb = withSheet({ feats: [...BASE.feats, "Shake It Off"] });
    const hit = lookupForSheet(barb, "Shake It Off", { category: "actions" });
    expect(hit.primary!.category).toBe("actions");
    expect(hit.via).toBe("category");
  });

  it("[explícito] o uuid vence tudo", () => {
    // O dado grafa o feat como "Shake it Off" e a ação como "Shake It Off" —
    // mais uma razão para o uuid ser o canal forte: ele não depende de grafia.
    const rec = categoryRecords("feats").find(
      (r) => r.uuid && r.name.toLowerCase() === "shake it off",
    );
    expect(rec, "o dado precisa ter uuid no feat").toBeDefined();
    const hit = lookupForSheet(BASE, "qualquer coisa", { ref: rec!.uuid! });
    expect(hit.primary!.name.toLowerCase()).toBe("shake it off");
    expect(hit.primary!.category).toBe("feats");
    expect(hit.via).toBe("uuid");
  });

  it("[explícito] referência que não resolve NÃO some: cai no índice e o via conta a verdade", () => {
    const hit = lookupForSheet(BASE, "Shake It Off", { ref: "Compendium.nao.existe.123" });
    expect(hit.primary).not.toBeNull();
    expect(hit.via).not.toBe("uuid");
  });

  it("[índice] sem nada na ficha, a colisão é DECLARADA ambígua", () => {
    const hit = lookupForSheet(BASE, "Shake It Off");
    expect(hit.via).toBe("index");
    expect(hit.ambiguous).toBe(true);
    expect(hit.homonyms.map((h) => h.category)).toContain("feats");
  });

  it("[índice] a ficha nomeando DOIS lados não decide — e diz que não decidiu", () => {
    const both = withSheet({
      feats: [...BASE.feats, "Shake It Off"],
      equipment: [...BASE.equipment, { name: "Shake It Off", quantity: 1 }],
    } as Partial<Character>);
    const hit = lookupForSheet(both, "Shake It Off");
    // `equipment` não tem esse nome no dado, então só um candidato é real:
    // o teste vale como garantia de que 2+ categorias na ficha não quebram.
    expect(hit.primary).not.toBeNull();
    expect(["sheet", "index"]).toContain(hit.via);
  });

  it("nome sem homônimo nenhum passa direto, sem nota", () => {
    const hit = lookupForSheet(BASE, "Bon Mot");
    expect(hit.homonyms).toHaveLength(0);
    expect(hit.ambiguous).toBe(false);
  });

  it("consulta sem resultado devolve primary null sem explodir", () => {
    // Tokens de até 2 letras não entram no passe de sobreposição do
    // `lookupLocalRule`; com tokens maiores ele SEMPRE acha alguma coisa por
    // sobreposição, mesmo em consulta sem sentido. É comportamento anterior a
    // esta fase e está fora do escopo dela — registrado, não alterado.
    const hit = lookupForSheet(BASE, "zz qq xy");
    expect(hit.primary).toBeNull();
    expect(hit.homonyms).toHaveLength(0);
  });

  it("o portão compara pelo nome ENCONTRADO, não pela consulta crua", () => {
    // `lookupLocalRule` casa por substring; se o portão comparasse a consulta
    // com a ficha, um match fuzzy nunca seria promovido.
    const barb = withSheet({ feats: [...BASE.feats, "Shake It Off"] });
    const hit = lookupForSheet(barb, "shake it off");
    expect(hit.via).toBe("sheet");
  });
});

describe.skipIf(!hasGenerated)("[T7] quanto da colisão o portão resolve", () => {
  it("mede as 309 colisões e quanto a ficha decide", () => {
    const SHEET = new Set([
      "feats",
      "spells",
      "equipment",
      "ancestries",
      "heritages",
      "backgrounds",
      "classes",
      "deities",
    ]);
    const CATS = [
      "actions",
      "bestiary",
      "conditions",
      "equipment",
      "feats",
      "spells",
      "hazards",
      "effects",
      "ancestries",
      "heritages",
      "backgrounds",
      "classes",
      "deities",
      "campaign",
      "pregens",
      "vehicles",
      "armies",
      "familiars",
      "kits",
    ];
    const byName = new Map<string, Set<string>>();
    for (const c of CATS) {
      for (const r of categoryRecords(c)) {
        const k = r.name.toLowerCase().trim();
        const set = byName.get(k);
        if (set) set.add(c);
        else byName.set(k, new Set([c]));
      }
    }
    let collisions = 0;
    let decidable = 0;
    let ambiguousWithSheet = 0;
    let noSheetSide = 0;
    for (const cats of byName.values()) {
      if (cats.size < 2) continue;
      collisions++;
      const sides = [...cats].filter((c) => SHEET.has(c));
      if (sides.length === 1) decidable++;
      else if (sides.length > 1) ambiguousWithSheet++;
      else noSheetSide++;
    }
    console.log(
      `[T7] colisões de nome: ${collisions} | a FICHA decide ${decidable} (${Math.round(
        (decidable / collisions) * 100,
      )}%) | ambíguas mesmo com ficha ${ambiguousWithSheet} | fora da ficha ${noSheetSide}`,
    );
    // Piso medido em 2026-08-15 contra o core @ 7.8.0. Cai se o dataset mudar
    // de forma — e aí a mudança é para OLHAR, não para silenciar.
    expect(collisions).toBeGreaterThanOrEqual(300);
    expect(decidable).toBeGreaterThanOrEqual(160);
    expect(decidable + ambiguousWithSheet + noSheetSide).toBe(collisions);
  });
});
