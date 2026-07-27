import { describe, expect, it } from "vitest";
import {
  adjustDamage,
  classifyDefense,
  normalizeDamageType,
  parsePlayerResistances,
  scaleParcels,
  UNTYPED,
  type DamageParcel,
} from "./damage.js";

const p = (amount: number, type: string, category?: DamageParcel["category"]): DamageParcel => ({
  amount,
  type,
  ...(category ? { category } : {}),
});

describe("normalizeDamageType", () => {
  it("hifeniza, tira 'persistent'/'damage' e resolve alias pré-remaster", () => {
    expect(normalizeDamageType("Cold Iron")).toBe("cold-iron");
    expect(normalizeDamageType("persistent fire")).toBe("fire");
    expect(normalizeDamageType("bludgeoning damage")).toBe("bludgeoning");
    expect(normalizeDamageType("positive")).toBe("vitality");
    expect(normalizeDamageType("negative")).toBe("void");
  });

  it("trata a sentinela do benchmark e o vazio como untyped", () => {
    // strikeProfileFrom sem statblock grava type "damage" — não é tipo PF2e.
    expect(normalizeDamageType("damage")).toBe(UNTYPED);
    expect(normalizeDamageType("")).toBe(UNTYPED);
    expect(normalizeDamageType(undefined)).toBe(UNTYPED);
  });
});

describe("adjustDamage — imunidade", () => {
  it("zera a parcela do tipo imune e preserva as demais", () => {
    const adj = adjustDamage([p(10, "fire"), p(6, "slashing")], { immunities: ["fire"] });
    expect(adj.raw).toBe(16);
    expect(adj.applied).toBe(6);
    expect(adj.note).toContain("immune to fire");
  });

  it("imunidade a condição não vira imunidade a dano", () => {
    const adj = adjustDamage([p(10, "fire")], { immunities: ["paralyzed", "sleep"] });
    expect(adj.applied).toBe(10);
    expect(adj.note).toBe("");
  });
});

describe("adjustDamage — resistência e fraqueza", () => {
  it("resistência subtrai e nunca leva o dano abaixo de zero", () => {
    expect(adjustDamage([p(7, "cold")], { resistances: [{ type: "cold", value: 5 }] }).applied).toBe(2);
    expect(adjustDamage([p(3, "cold")], { resistances: [{ type: "cold", value: 5 }] }).applied).toBe(0);
  });

  it("fraqueza soma uma vez por instância, não por dado rolado", () => {
    const adj = adjustDamage([p(4, "fire"), p(4, "fire")], {
      weaknesses: [{ type: "fire", value: 5 }],
    });
    // 4+4 = 8 numa única instância de fogo → +5, não +10.
    expect(adj.applied).toBe(13);
  });

  it("aplica fraqueza ANTES da resistência (ordem RAW)", () => {
    const adj = adjustDamage([p(10, "fire")], {
      weaknesses: [{ type: "fire", value: 5 }],
      resistances: [{ type: "fire", value: 3 }],
    });
    expect(adj.applied).toBe(12); // (10 + 5) - 3
  });

  it("usa só a MAIOR resistência aplicável, não a soma", () => {
    const adj = adjustDamage([p(20, "slashing")], {
      resistances: [
        { type: "slashing", value: 5 },
        { type: "physical", value: 10 },
      ],
    });
    expect(adj.applied).toBe(10);
  });

  it("imunidade vence fraqueza no mesmo tipo", () => {
    const adj = adjustDamage([p(10, "fire")], {
      immunities: ["fire"],
      weaknesses: [{ type: "fire", value: 5 }],
    });
    expect(adj.applied).toBe(0);
  });
});

describe("adjustDamage — metatipos", () => {
  it("resistência a physical cobre bludgeoning/piercing/slashing/bleed", () => {
    const def = { resistances: [{ type: "physical", value: 5 }] };
    expect(adjustDamage([p(10, "slashing")], def).applied).toBe(5);
    expect(adjustDamage([p(10, "bleed")], def).applied).toBe(5);
    // ...e NÃO cobre energia.
    expect(adjustDamage([p(10, "fire")], def).applied).toBe(10);
  });

  it("resistência a energy cobre fogo mas não corte", () => {
    const def = { resistances: [{ type: "energy", value: 4 }] };
    expect(adjustDamage([p(10, "fire")], def).applied).toBe(6);
    expect(adjustDamage([p(10, "slashing")], def).applied).toBe(10);
  });

  it("all-damage cobre inclusive dano sem tipo", () => {
    const def = { resistances: [{ type: "all-damage", value: 5 }] };
    expect(adjustDamage([p(10, UNTYPED)], def).applied).toBe(5);
  });

  it("dano sem tipo ignora resistência tipada", () => {
    const adj = adjustDamage([p(10, "damage")], { resistances: [{ type: "fire", value: 5 }] });
    expect(adj.applied).toBe(10);
    expect(adj.note).toBe("");
  });
});

describe("adjustDamage — categorias isoláveis", () => {
  it("imunidade a precisão derruba só a parcela de sneak attack", () => {
    const adj = adjustDamage([p(8, "piercing"), p(7, "piercing", "precision")], {
      immunities: ["precision"],
    });
    expect(adj.applied).toBe(8);
    expect(adj.note).toContain("immune to precision");
  });

  it("fraqueza a splash-damage pega a parcela de splash da bomba", () => {
    const adj = adjustDamage([p(6, "fire"), p(1, "fire", "splash")], {
      weaknesses: [{ type: "splash-damage", value: 5 }],
    });
    // Só a parcela de splash ganha os +5; a direta passa intacta.
    expect(adj.applied).toBe(12);
  });
});

describe("adjustDamage — bordas", () => {
  it("dano negativo é ignorado e não gera nota", () => {
    const adj = adjustDamage([p(-5, "fire")], { weaknesses: [{ type: "fire", value: 5 }] });
    expect(adj.raw).toBe(0);
    expect(adj.applied).toBe(0);
    expect(adj.note).toBe("");
  });

  it("sem defesas, o dano passa inteiro", () => {
    const adj = adjustDamage([p(9, "fire"), p(3, "cold")], undefined);
    expect(adj.applied).toBe(12);
    expect(adj.note).toBe("");
  });
});

describe("scaleParcels", () => {
  it("preserva EXATAMENTE o total pedido (metade de save básico)", () => {
    const out = scaleParcels([p(7, "fire"), p(4, "sonic")], 5);
    expect(out.reduce((s, x) => s + x.amount, 0)).toBe(5);
    expect(out.map((x) => x.type)).toEqual(["fire", "sonic"]);
  });

  it("dobrar não perde nada", () => {
    const out = scaleParcels([p(7, "fire"), p(4, "sonic")], 22);
    expect(out.reduce((s, x) => s + x.amount, 0)).toBe(22);
  });

  it("total zero zera as parcelas", () => {
    expect(scaleParcels([p(7, "fire")], 0).every((x) => x.amount === 0)).toBe(true);
  });
});

describe("classifyDefense", () => {
  it("separa tipo, metatipo, categoria, não suportado e não-dano", () => {
    expect(classifyDefense("fire")).toBe("damage-type");
    expect(classifyDefense("physical")).toBe("meta");
    expect(classifyDefense("all-damage")).toBe("meta");
    expect(classifyDefense("precision")).toBe("category");
    expect(classifyDefense("cold-iron")).toBe("unsupported");
    expect(classifyDefense("paralyzed")).toBe("not-damage");
  });

  it("entrada desconhecida é 'unknown' — some no teste, não no jogo", () => {
    expect(classifyDefense("plasma-vulnerability")).toBe("unknown");
  });
});

describe("parsePlayerResistances", () => {
  it("lê 'Fire 5' e 'resistance to cold 2' da ficha do Pathbuilder", () => {
    const out = parsePlayerResistances(["Fire 5", "resistance to cold 2"]);
    expect(out.resistances).toEqual([
      { type: "fire", value: 5 },
      { type: "cold", value: 2 },
    ]);
    expect(out.unparsed).toEqual([]);
  });

  it("entrada sem valor numérico fica DECLARADA, nunca vira 0", () => {
    const out = parsePlayerResistances(["Fire", "Resistant to charm"]);
    expect(out.resistances).toEqual([]);
    expect(out.unparsed).toEqual(["Fire", "Resistant to charm"]);
  });

  it("lista vazia (o caso comum do Pathbuilder) não inventa nada", () => {
    expect(parsePlayerResistances([]).resistances).toEqual([]);
    expect(parsePlayerResistances(undefined).resistances).toEqual([]);
  });
});
