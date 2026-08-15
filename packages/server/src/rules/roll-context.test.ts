/**
 * A ponte estado→roll options (Fase 2.5 / T5.1).
 *
 * O que se testa aqui não é o vocabulário (isso é `roll-options.test.ts`), e sim
 * a TRADUÇÃO: o que a ficha e o combate afirmam, e sobretudo o que eles NÃO
 * afirmam. Ausência mal traduzida é o bug caro deste módulo — uma arma
 * arremessável declarada "não é à distância" faria um `not:item:ranged` passar.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Character, Combatant } from "@pf2e/shared";
import { rollOptionsForCheck } from "./roll-context.js";
import { coversStatement } from "./roll-options.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));

function mkCharacter(over: Partial<Character> = {}): Character {
  return {
    name: "Jão",
    level: 5,
    ancestry: "Elf",
    heritage: "Woodland Elf",
    className: "Fighter",
    feats: ["Power Attack", "Incredible Initiative"],
    classFeatures: ["Attack of Opportunity"],
    skills: {
      athletics: { name: "athletics", ability: "str", rank: 2, modifier: 13 },
      stealth: { name: "stealth", ability: "dex", rank: 1, modifier: 9 },
    },
    lores: [{ name: "Sailing", rank: 1, modifier: 9 }],
    ...over,
  } as unknown as Character;
}

function mkCombatant(over: Partial<Combatant> = {}): Combatant {
  return {
    id: "x",
    name: "Alvo",
    kind: "enemy",
    initiative: 10,
    ac: 18,
    maxHp: 30,
    currentHp: 30,
    conditions: [],
    actionsRemaining: 3,
    reactionAvailable: true,
    mapProgress: 0,
    level: 3,
    traits: ["undead", "mindless"],
    defeated: false,
    ...over,
  } as Combatant;
}

describe("rollOptionsForCheck — a ficha vira vocabulário", () => {
  it("classe, ancestralidade, herança, feats e features viram opções", () => {
    const { options } = rollOptionsForCheck({ character: mkCharacter() });
    expect(options.has("class:fighter")).toBe(true);
    expect(options.has("ancestry:elf")).toBe(true);
    expect(options.has("heritage:woodland-elf")).toBe(true);
    expect(options.has("feat:power-attack")).toBe(true);
    expect(options.has("feature:attack-of-opportunity")).toBe(true);
  });

  it("a ancestralidade entra TAMBÉM como traço do ator", () => {
    // Sem isso, `self:trait` ficaria coberto com conjunto vazio e um elfo
    // responderia FALSO a `self:trait:elf` — pior que não saber.
    const { options } = rollOptionsForCheck({ character: mkCharacter() });
    expect(options.has("self:trait:elf")).toBe(true);
  });

  it("perícias e lores levam o rank real", () => {
    const { options } = rollOptionsForCheck({ character: mkCharacter() });
    expect(options.has("skill:athletics:rank:2")).toBe(true);
    expect(options.has("skill:stealth:rank:1")).toBe(true);
    expect(options.has("skill:sailing-lore:rank:1")).toBe(true);
  });

  it("fora de combate as condições vêm do GameState", () => {
    const { options } = rollOptionsForCheck({
      character: mkCharacter(),
      selfConditions: ["frightened 2"],
    });
    expect(options.has("self:condition:frightened")).toBe(true);
    expect(options.has("self:condition:frightened:2")).toBe(true);
  });

  it("em combate o combatente manda nas condições e no nível", () => {
    const self = mkCombatant({ kind: "player", level: 7, conditions: ["off-guard"] });
    const { options } = rollOptionsForCheck({
      character: mkCharacter(),
      self,
      selfConditions: ["frightened 2"],
    });
    expect(options.has("self:condition:off-guard")).toBe(true);
    expect(options.has("self:condition:frightened")).toBe(false);
    expect(options.has("self:level:7")).toBe(true);
  });
});

describe("rollOptionsForCheck — o alvo", () => {
  it("traços, nível e condições do alvo viram opções", () => {
    const ro = rollOptionsForCheck({ target: mkCombatant({ conditions: ["prone"] }) });
    expect(ro.options.has("target:trait:undead")).toBe(true);
    expect(ro.options.has("target:level:3")).toBe(true);
    expect(ro.options.has("target:condition:prone")).toBe(true);
  });

  it("sem alvo, `target:*` é INDECIDÍVEL — não é falso", () => {
    const ro = rollOptionsForCheck({ character: mkCharacter() });
    expect(coversStatement(ro, "target:trait:undead")).toBe(false);
    expect(coversStatement(ro, "target:condition:off-guard")).toBe(false);
  });

  it("o inimigo que rola não recebe vocabulário de ficha", () => {
    const ro = rollOptionsForCheck({ self: mkCombatant() });
    expect(ro.options.has("self:trait:undead")).toBe(true);
    expect(coversStatement(ro, "class:fighter")).toBe(false);
    expect(coversStatement(ro, "feat:power-attack")).toBe(false);
  });
});

describe("rollOptionsForCheck — ação e item", () => {
  it("a ação vira `action:*`", () => {
    const ro = rollOptionsForCheck({ action: "Trip" });
    expect(ro.options.has("action:trip")).toBe(true);
  });

  it("sem item nenhum, `item:trait` fica indecidível", () => {
    const ro = rollOptionsForCheck({ character: mkCharacter(), action: "Strike" });
    expect(coversStatement(ro, "item:trait:agile")).toBe(false);
  });

  it("melee/ranged declarados por quem chama vencem o dado", () => {
    const ro = rollOptionsForCheck({ item: "Dagger", melee: false, ranged: true });
    expect(ro.options.has("item:ranged")).toBe(true);
    expect(ro.options.has("item:melee")).toBe(false);
    expect(coversStatement(ro, "item:melee")).toBe(true);
  });
});

describe.skipIf(!hasGenerated)("rollOptionsForCheck — item resolvido no dataset", () => {
  it("traços, categoria e tipo de dano saem do dado", () => {
    const { options } = rollOptionsForCheck({ item: "Longsword" });
    expect(options.has("item:trait:versatile-p")).toBe(true);
    expect(options.has("item:category:martial")).toBe(true);
    expect(options.has("item:damage:type:slashing")).toBe(true);
    expect(options.has("item:base:longsword")).toBe(true);
    // Traço solto também: 955 predicados do dado testam sem prefixo (T2).
    expect(options.has("versatile-p")).toBe(true);
  });

  it("arma sem alcance é corpo a corpo; com alcance, é à distância", () => {
    expect(rollOptionsForCheck({ item: "Longsword" }).options.has("item:melee")).toBe(true);
    expect(rollOptionsForCheck({ item: "Longbow" }).options.has("item:ranged")).toBe(true);
    expect(rollOptionsForCheck({ item: "Longbow" }).options.has("item:melee")).toBe(false);
  });

  it("arma ARREMESSÁVEL não afirma nem uma coisa nem outra", () => {
    // Adaga tem `thrown-10`: serve de corpo a corpo E de arremesso. Declarar
    // qualquer um dos dois como falso daria permissão a um `not:`.
    const ro = rollOptionsForCheck({ item: "Dagger" });
    expect(coversStatement(ro, "item:melee")).toBe(false);
    expect(coversStatement(ro, "item:ranged")).toBe(false);
    expect(ro.options.has("item:trait:agile")).toBe(true);
  });

  it("runas e material não impedem o item BASE de ser reconhecido", () => {
    const { options } = rollOptionsForCheck({ item: "+1 striking longsword" });
    expect(options.has("item:base:longsword")).toBe(true);
  });

  it("o tipo de dano da ficha (`P`) chega expandido ao vocabulário do dado", () => {
    const { options } = rollOptionsForCheck({ item: "Dagger", damageType: "P" });
    expect(options.has("item:damage:type:piercing")).toBe(true);
  });
});
