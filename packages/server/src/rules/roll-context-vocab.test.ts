/**
 * O vocabulário que a ficha já respondia e ninguém perguntava (Fase 2.6 / T6.4).
 *
 * Cinco famílias, todas escolhidas por MEDIÇÃO dos indecidíveis que sobraram
 * depois da T6.2: `check:statistic` (10), `self:armored` (4), `armor:category`
 * (4), `item:magical` (3) e `item:proficiency:rank` (3). Nenhuma delas precisava
 * de subsistema novo — só de alguém traduzir o campo da ficha.
 *
 * A regra do módulo continua valendo em cada caso: campo AUSENTE na ficha não
 * vira negação.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Character } from "@pf2e/shared";
import { evaluate } from "./predicate.js";
import { rollOptionsForCheck } from "./roll-context.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));

function mkCharacter(over: Partial<Character> = {}): Character {
  return {
    name: "Jão",
    level: 5,
    className: "Rogue",
    ancestry: "Goblin",
    heritage: null,
    feats: [],
    classFeatures: [],
    skills: {},
    lores: [],
    weapons: [],
    ...over,
  } as unknown as Character;
}

const truth = (stmt: string, c: Character, extra: Record<string, unknown> = {}) =>
  evaluate(stmt, rollOptionsForCheck({ character: c, ...extra })).value;

describe("armadura vestida", () => {
  const studded = { name: "Studded Leather Armor", proficiency: "light", worn: true };

  it("armadura leve vestida: armado, e a categoria é conhecida", () => {
    const c = mkCharacter({ armor: [studded] } as Partial<Character>);
    expect(truth("self:armored", c)).toBe("true");
    expect(truth("armor:category:light", c)).toBe("true");
    expect(truth("armor:category:heavy", c)).toBe("false");
  });

  it("`unarmored` conta como NÃO armado — é o que o predicado pergunta", () => {
    const c = mkCharacter({
      armor: [{ name: "Explorer's Clothing", proficiency: "unarmored", worn: true }],
    } as Partial<Character>);
    expect(truth("self:armored", c)).toBe("false");
    expect(truth("armor:category:unarmored", c)).toBe("true");
  });

  it("armadura na mochila (não vestida) não conta", () => {
    const c = mkCharacter({
      armor: [{ name: "Full Plate", proficiency: "heavy", worn: false }],
    } as Partial<Character>);
    expect(truth("self:armored", c)).toBe("false");
  });

  it("ficha SEM o campo armor fica indecidível, não 'sem armadura'", () => {
    // Dizer "não veste armadura" por ausência de dado faria o `not:` de
    // Incredible Movement conceder velocidade a um cavaleiro de placa.
    const c = mkCharacter();
    expect(truth("self:armored", c)).toBe("unknown");
    expect(truth("armor:category:light", c)).toBe("unknown");
    expect(evaluate({ not: "self:armored" }, rollOptionsForCheck({ character: c })).value).toBe(
      "unknown",
    );
  });
});

describe("a estatística da rolagem", () => {
  it("a estatística rolada é afirmada, e as outras negadas", () => {
    const c = mkCharacter();
    expect(truth("check:statistic:stealth", c, { statistic: "stealth" })).toBe("true");
    expect(truth("check:statistic:intimidation", c, { statistic: "stealth" })).toBe("false");
  });

  it("`check:statistic:base:*` segue indecidível — é estatística DERIVADA", () => {
    const c = mkCharacter();
    expect(truth("check:statistic:base:stealth", c, { statistic: "stealth" })).toBe("unknown");
  });

  it("rank vira nome de proficiência", () => {
    const c = mkCharacter();
    expect(truth("proficiency:expert", c, { statistic: "stealth", statisticRank: 2 })).toBe("true");
    expect(truth("proficiency:untrained", c, { statistic: "stealth", statisticRank: 2 })).toBe(
      "false",
    );
    expect(truth("proficiency:untrained", c, { statistic: "stealth", statisticRank: 0 })).toBe(
      "true",
    );
  });

  it("sem rank (percepção e saves do Pathbuilder) fica indecidível", () => {
    // O export traz o bônus final desses, não o rank. Responder "destreinado"
    // por não saber seria pior que não responder.
    const c = mkCharacter();
    expect(truth("proficiency:untrained", c, { statistic: "perception" })).toBe("unknown");
  });
});

describe.skipIf(!hasGenerated)("item mágico e proficiência da arma", () => {
  const c = () =>
    mkCharacter({ weaponProficiencies: { simple: 4, martial: 2 } } as Partial<Character>);

  it("runa de potência torna a arma mágica (RAW)", () => {
    expect(truth("item:magical", c(), { item: "Longsword +1 (striking)" })).toBe("true");
  });

  it("arma sem runa NÃO é mágica — e a engine sabe disso", () => {
    expect(truth("item:magical", c(), { item: "Longsword" })).toBe("false");
  });

  it("proficiência sai da CATEGORIA da arma, não do nome", () => {
    // Dagger é simple (rank 4 nesta ficha); Longsword é martial (rank 2).
    const opts = rollOptionsForCheck({ character: c(), item: "Dagger" });
    expect(opts.options.has("item:proficiency:rank:4")).toBe(true);
    const ls = rollOptionsForCheck({ character: c(), item: "Longsword" });
    expect(ls.options.has("item:proficiency:rank:2")).toBe(true);
  });

  it("o `gte` do dado compara contra o rank real", () => {
    const withDagger = { character: c(), item: "Dagger" };
    expect(evaluate({ gte: ["item:proficiency:rank", 3] }, rollOptionsForCheck(withDagger)).value).toBe(
      "true",
    );
    const withSword = { character: c(), item: "Longsword" };
    expect(evaluate({ gte: ["item:proficiency:rank", 3] }, rollOptionsForCheck(withSword)).value).toBe(
      "false",
    );
  });

  it("ficha sem weaponProficiencies não inventa rank", () => {
    const bare = mkCharacter();
    const opts = rollOptionsForCheck({ character: bare, item: "Dagger" });
    expect([...opts.options].some((o) => o.startsWith("item:proficiency"))).toBe(false);
    expect(evaluate({ gte: ["item:proficiency:rank", 1] }, opts).value).toBe("unknown");
  });
});

describe.skipIf(!hasGenerated)("o feat que estava travado nisso", () => {
  it("Blackjacket Dedication olha a categoria da armadura", () => {
    // O predicado do feat é `armor:category:medium`. Antes da T6.4 era
    // indecidível para qualquer ficha; agora responde pela armadura vestida.
    const medium = mkCharacter({
      feats: ["Blackjacket Dedication"],
      armor: [{ name: "Chain Mail", proficiency: "medium", worn: true }],
    } as Partial<Character>);
    expect(truth("armor:category:medium", medium)).toBe("true");
    const light = mkCharacter({
      armor: [{ name: "Leather Armor", proficiency: "light", worn: true }],
    } as Partial<Character>);
    expect(truth("armor:category:medium", light)).toBe("false");
  });
});
