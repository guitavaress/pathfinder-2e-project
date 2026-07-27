import { describe, expect, it } from "vitest";
import { evaluate, isSatisfied } from "./predicate.js";
import { rollOptionsFor, type RollOptionContext } from "./roll-options.js";

/** Jogador nível 5 golpeando um esqueleto off-guard com rapieira ágil. */
const ctx: RollOptionContext = {
  self: {
    kind: "player",
    level: 5,
    traits: [],
    conditions: ["frightened 2"],
    className: "Rogue",
    feats: ["Nimble Dodge"],
    classFeatures: ["Sneak Attack"],
    skills: { athletics: { rank: 2 }, stealth: { rank: 4 } },
  },
  target: { kind: "enemy", level: 2, traits: ["undead"], conditions: ["off-guard"] },
  action: "Strike",
  item: { name: "Rapier", traits: ["agile", "finesse"], type: "weapon", melee: true },
};
const ro = rollOptionsFor(ctx);
const v = (p: unknown) => evaluate(p, ro).value;

describe("statement simples", () => {
  it("verdadeiro quando a opção está afirmada", () => {
    expect(v(["target:condition:off-guard"])).toBe("true");
    expect(v(["item:trait:agile"])).toBe("true");
    expect(v(["action:strike"])).toBe("true");
  });

  it("falso quando o domínio é coberto e a opção não está lá", () => {
    expect(v(["target:condition:restrained"])).toBe("false");
    expect(v(["class:barbarian"])).toBe("false");
  });

  it("INDECIDÍVEL quando o domínio não é modelado", () => {
    const r = evaluate(["self:effect:rage"], ro);
    expect(r.value).toBe("unknown");
    expect(r.undecided).toContain("self:effect:rage");
  });
});

describe("operadores lógicos", () => {
  it("array no topo é conjunção implícita", () => {
    expect(v(["target:condition:off-guard", "item:trait:agile"])).toBe("true");
    expect(v(["target:condition:off-guard", "class:barbarian"])).toBe("false");
  });

  it("or basta um verdadeiro", () => {
    expect(v([{ or: ["class:barbarian", "class:rogue"] }])).toBe("true");
    expect(v([{ or: ["class:barbarian", "class:fighter"] }])).toBe("false");
  });

  it("and precisa de todos", () => {
    expect(v([{ and: ["class:rogue", "target:trait:undead"] }])).toBe("true");
    expect(v([{ and: ["class:rogue", "target:trait:dragon"] }])).toBe("false");
  });

  it("not inverte", () => {
    expect(v([{ not: "target:trait:dragon" }])).toBe("true");
    expect(v([{ not: "target:trait:undead" }])).toBe("false");
  });

  it("nor e nand negam or e and", () => {
    expect(v([{ nor: ["class:barbarian", "class:fighter"] }])).toBe("true");
    expect(v([{ nor: ["class:barbarian", "class:rogue"] }])).toBe("false");
    expect(v([{ nand: ["class:rogue", "target:trait:dragon"] }])).toBe("true");
    expect(v([{ nand: ["class:rogue", "target:trait:undead"] }])).toBe("false");
  });

  it("aninha na profundidade que o dataset usa", () => {
    expect(
      v([
        {
          or: [
            { and: ["class:rogue", { not: "target:trait:dragon" }] },
            { and: ["class:barbarian", "target:condition:off-guard"] },
          ],
        },
      ]),
    ).toBe("true");
  });
});

describe("lógica de três valores — unknown NÃO é falso", () => {
  it("not sobre indecidível continua indecidível", () => {
    // O bug que isto impede: `not` sobre domínio que não modelamos viraria
    // VERDADEIRO e o rule element seria aplicado sem base nenhuma.
    expect(v([{ not: "self:effect:rage" }])).toBe("unknown");
  });

  it("or com um verdadeiro decide mesmo tendo indecidível ao lado", () => {
    expect(v([{ or: ["self:effect:rage", "class:rogue"] }])).toBe("true");
  });

  it("and com um falso decide mesmo tendo indecidível ao lado", () => {
    expect(v([{ and: ["self:effect:rage", "class:barbarian"] }])).toBe("false");
  });

  it("or só de indecidíveis fica indecidível", () => {
    expect(v([{ or: ["self:effect:rage", "target:mark:hunted-prey"] }])).toBe("unknown");
  });

  it("isSatisfied só deixa passar o seguramente verdadeiro", () => {
    expect(isSatisfied(["class:rogue"], ro)).toBe(true);
    expect(isSatisfied([{ not: "self:effect:rage" }], ro)).toBe(false);
  });
});

describe("comparações numéricas", () => {
  it("resolve a chave pelo sufixo da opção (self:level:5 → 5)", () => {
    expect(v([{ gte: ["self:level", 5] }])).toBe("true");
    expect(v([{ gte: ["self:level", 6] }])).toBe("false");
    expect(v([{ lt: ["self:level", 6] }])).toBe("true");
    expect(v([{ lte: ["self:level", 4] }])).toBe("false");
    expect(v([{ gt: ["self:level", 4] }])).toBe("true");
  });

  it("compara duas chaves entre si (23 casos no dataset)", () => {
    expect(v([{ gt: ["self:level", "target:level"] }])).toBe("true");
    expect(v([{ lt: ["self:level", "target:level"] }])).toBe("false");
  });

  it("lê o grau de uma condição com valor", () => {
    expect(v([{ gte: ["self:condition:frightened", 2] }])).toBe("true");
    expect(v([{ gte: ["self:condition:frightened", 3] }])).toBe("false");
  });

  it("lê o rank de perícia da ficha", () => {
    expect(v([{ gte: ["skill:stealth:rank", 4] }])).toBe("true");
    expect(v([{ gte: ["skill:athletics:rank", 3] }])).toBe("false");
  });

  it("quantidade ausente em domínio COBERTO é falso, não indecidível", () => {
    // Não estar amaldiçoado é uma resposta; não é ignorância.
    expect(v([{ gte: ["self:condition:cursebound", 1] }])).toBe("false");
  });

  it("chave de domínio não modelado é INDECIDÍVEL", () => {
    const r = evaluate([{ gte: ["self:effect:rage", 1] }], ro);
    expect(r.value).toBe("unknown");
    expect(r.undecided).toContain("self:effect:rage");
  });
});

describe("formas fora da gramática nunca viram verdadeiro", () => {
  it("operador desconhecido fica registrado e indecidível", () => {
    const r = evaluate([{ betwixt: ["self:level", 3] }], ro);
    expect(r.value).toBe("unknown");
    expect(r.malformed).toContain("betwixt");
  });

  it("objeto com duas chaves é ambíguo — e ambiguidade não passa", () => {
    const r = evaluate([{ or: ["class:rogue"], and: ["class:rogue"] }], ro);
    expect(r.value).toBe("unknown");
    expect(r.malformed.length).toBe(1);
  });

  it("or sem array e comparação sem par são rejeitados", () => {
    expect(evaluate([{ or: "class:rogue" }], ro).value).toBe("unknown");
    expect(evaluate([{ gte: ["self:level"] }], ro).value).toBe("unknown");
  });

  it("predicado ausente é sempre verdadeiro (52% dos rule elements)", () => {
    expect(evaluate(undefined, ro).value).toBe("true");
    expect(evaluate(null, ro).value).toBe("true");
    expect(evaluate([], ro).value).toBe("true");
  });
});
