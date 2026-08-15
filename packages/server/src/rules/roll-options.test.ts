import { describe, expect, it } from "vitest";
import {
  coversStatement,
  prefixOf,
  rollOptionsFor,
  slug,
  type RollOptionContext,
} from "./roll-options.js";

/** Contexto típico de um golpe do jogador contra um esqueleto off-guard. */
const strikeCtx: RollOptionContext = {
  self: {
    kind: "player",
    level: 5,
    traits: [],
    conditions: ["frightened 2"],
    className: "Rogue",
    feats: ["Nimble Dodge", "Twin Feint"],
    classFeatures: ["Sneak Attack", "Surprise Attack"],
    skills: { athletics: { rank: 2 }, stealth: { rank: 4 } },
  },
  target: {
    kind: "enemy",
    level: 2,
    traits: ["undead", "skeleton"],
    conditions: ["off-guard"],
  },
  action: "Strike",
  item: {
    name: "Rapier",
    traits: ["deadly-d8", "disarm", "finesse"],
    type: "weapon",
    category: "martial",
    melee: true,
    damageType: "piercing",
  },
};

describe("slug", () => {
  it("normaliza para o kebab-case que o dado usa", () => {
    expect(slug("Recall Knowledge")).toBe("recall-knowledge");
    expect(slug("Nimble Dodge")).toBe("nimble-dodge");
    expect(slug("Tremorsense (Imprecise)")).toBe("tremorsense");
    expect(slug("Elfo Anão")).toBe("elfo-anao");
  });
});

describe("rollOptionsFor — ator", () => {
  it("afirma tipo, nível, traços e condições dos dois lados", () => {
    const { options } = rollOptionsFor(strikeCtx);
    expect(options.has("self:type:character")).toBe(true);
    expect(options.has("self:level:5")).toBe(true);
    expect(options.has("target:type:npc")).toBe(true);
    expect(options.has("target:level:2")).toBe(true);
    expect(options.has("target:trait:undead")).toBe(true);
    expect(options.has("target:condition:off-guard")).toBe(true);
  });

  it("condição com valor vira as DUAS formas: presença e grau", () => {
    const { options } = rollOptionsFor(strikeCtx);
    expect(options.has("self:condition:frightened")).toBe(true);
    expect(options.has("self:condition:frightened:2")).toBe(true);
  });

  it("condição sem valor conta como grau 1 (RAW)", () => {
    const { options } = rollOptionsFor({ self: { conditions: ["off-guard"] } });
    expect(options.has("self:condition:off-guard:1")).toBe(true);
  });

  it("off-guard responde também pelo nome pré-remaster", () => {
    // Conteúdo antigo do dataset ainda testa `flat-footed`.
    const { options } = rollOptionsFor(strikeCtx);
    expect(options.has("target:condition:flat-footed")).toBe(true);
  });

  it("ficha vira class:/feat:/feature:/skill: — como o dado escreve", () => {
    const { options } = rollOptionsFor(strikeCtx);
    expect(options.has("class:rogue")).toBe(true);
    expect(options.has("feat:nimble-dodge")).toBe(true);
    expect(options.has("feature:sneak-attack")).toBe(true);
    expect(options.has("skill:stealth:rank:4")).toBe(true);
  });

  it("ancestralidade e herança saem sem prefixo self:", () => {
    const { options } = rollOptionsFor({
      self: { ancestry: "Goblin", heritage: "Irongut Goblin" },
    });
    expect(options.has("ancestry:goblin")).toBe(true);
    expect(options.has("heritage:irongut-goblin")).toBe(true);
  });
});

describe("rollOptionsFor — ação e item", () => {
  it("a ação corrente vira action:<slug>", () => {
    expect(rollOptionsFor({ action: "Recall Knowledge" }).options.has("action:recall-knowledge")).toBe(
      true,
    );
  });

  it("traço do item entra prefixado E solto", () => {
    const { options } = rollOptionsFor(strikeCtx);
    expect(options.has("item:trait:finesse")).toBe(true);
    // 955 predicados do dataset testam o traço sem prefixo nenhum.
    expect(options.has("finesse")).toBe(true);
  });

  it("descreve tipo, categoria, alcance e tipo de dano do item", () => {
    const { options } = rollOptionsFor(strikeCtx);
    expect(options.has("item:type:weapon")).toBe(true);
    expect(options.has("item:category:martial")).toBe(true);
    expect(options.has("item:melee")).toBe(true);
    expect(options.has("item:damage:type:piercing")).toBe(true);
    expect(options.has("item:slug:rapier")).toBe(true);
  });

  it("melee falso NÃO afirma item:melee, mas o domínio fica decidido", () => {
    const ro = rollOptionsFor({ item: { melee: false, ranged: true } });
    expect(ro.options.has("item:melee")).toBe(false);
    expect(coversStatement(ro, "item:melee")).toBe(true);
    expect(ro.options.has("item:ranged")).toBe(true);
  });

  it("item base é separado do nome: runas não apagam o tipo da arma", () => {
    // 177 predicados testam `item:base:*` — "Longsword +1 (striking)" tem de
    // continuar respondendo por `longsword`.
    const { options } = rollOptionsFor({
      item: { name: "Longsword +1 (striking)", base: "Longsword" },
    });
    expect(options.has("item:base:longsword")).toBe(true);
    expect(options.has("item:slug:longsword-1")).toBe(true);
  });

  it("magia leva o rank de conjuração", () => {
    const { options } = rollOptionsFor({ item: { name: "Fireball", type: "spell", rank: 3 } });
    expect(options.has("item:rank:3")).toBe(true);
    expect(options.has("item:type:spell")).toBe(true);
  });
});

describe("prefixOf", () => {
  it("pega o prefixo mais específico que conhecemos", () => {
    expect(prefixOf("self:condition:off-guard")).toBe("self:condition");
    expect(prefixOf("item:damage:type:bleed")).toBe("item:damage:type");
    expect(prefixOf("target:mark:hunted-prey")).toBe("target:mark");
    expect(prefixOf("self:effect:rage")).toBe("self:effect");
  });

  it("statement usado em comparação numérica é o próprio prefixo", () => {
    expect(prefixOf("self:level")).toBe("self:level");
    expect(prefixOf("skill:crafting:rank")).toBe("skill");
  });

  it("statement solto é traço", () => {
    expect(prefixOf("mental")).toBe("trait");
  });
});

describe("coversStatement — ausência NÃO é negação", () => {
  it("decide o que o contexto sustenta", () => {
    const ro = rollOptionsFor(strikeCtx);
    expect(coversStatement(ro, "target:condition:off-guard")).toBe(true);
    // Ausente E coberto: isso sim é falso de verdade.
    expect(coversStatement(ro, "target:condition:restrained")).toBe(true);
    expect(ro.options.has("target:condition:restrained")).toBe(false);
  });

  it("sem alvo no contexto, target:* é INDECIDÍVEL, não falso", () => {
    const ro = rollOptionsFor({ self: { kind: "player", level: 3 } });
    expect(coversStatement(ro, "target:condition:off-guard")).toBe(false);
  });

  it("domínio declarado como não modelado nunca é decidido", () => {
    const ro = rollOptionsFor(strikeCtx);
    expect(coversStatement(ro, "self:effect:rage")).toBe(false);
    expect(coversStatement(ro, "target:mark:hunted-prey")).toBe(false);
    expect(coversStatement(ro, "spellcasting:innate")).toBe(false);
    // Posicionamento é Fase 3 — declarado, não respondido.
    expect(coversStatement(ro, "target:distance")).toBe(false);
  });

  it("sem item, traço solto é indecidível", () => {
    const ro = rollOptionsFor({ self: { kind: "player" } });
    expect(coversStatement(ro, "mental")).toBe(false);
  });
});
