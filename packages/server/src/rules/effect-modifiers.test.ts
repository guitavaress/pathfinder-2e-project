/**
 * Os rule elements do EFEITO virando número (Fase 2.6 / T6.2).
 *
 * Duas metades: o efeito ativo torna `self:effect:*` decidível (destrava os
 * indecidíveis que a Fase 2.5 mediu), e os `FlatModifier`/defesas que o próprio
 * effect carrega passam a valer.
 *
 * Tudo com effects e feats REAIS do dado.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Character } from "@pf2e/shared";
import { actorDefensesFor, actorModifiersFor } from "./actor-modifiers.js";
import { ModifierStack } from "./modifiers.js";
import { rollOptionsForCheck } from "./roll-context.js";
import { coversStatement, rollOptionsFor } from "./roll-options.js";
import { evaluate } from "./predicate.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));

function mkCharacter(over: Partial<Character> = {}): Character {
  return {
    name: "Jão",
    level: 5,
    ancestry: "Human",
    heritage: null,
    background: "Hunter",
    className: "Swashbuckler",
    feats: [],
    classFeatures: [],
    skills: {},
    lores: [],
    ...over,
  } as unknown as Character;
}

const eff = (name: string) => ({ name, slug: name.replace(/^[^:]+:\s*/, "").toLowerCase() });

describe("self:effect nas roll options — três valores, não dois", () => {
  it("efeito ativo AFIRMA o statement", () => {
    const ro = rollOptionsFor({ self: { effects: ["panache"] } });
    expect(ro.options.has("self:effect:panache")).toBe(true);
    expect(evaluate("self:effect:panache", ro).value).toBe("true");
  });

  it("lista presente sem o efeito diz FALSO — a engine sabe que não está", () => {
    const ro = rollOptionsFor({ self: { effects: [] } });
    expect(evaluate("self:effect:panache", ro).value).toBe("false");
    expect(evaluate({ not: "self:effect:panache" }, ro).value).toBe("true");
  });

  it("lista AUSENTE segue indecidível — e `not:` não vira permissão", () => {
    const ro = rollOptionsFor({ self: { kind: "enemy", level: 3 } });
    expect(evaluate("self:effect:panache", ro).value).toBe("unknown");
    expect(evaluate({ not: "self:effect:panache" }, ro).value).toBe("unknown");
  });

  it("badge (contador) do efeito continua INDECIDÍVEL mesmo com a lista", () => {
    // `self:effect:overdrive-success:2` fala do contador do efeito no Foundry,
    // que o registro não guarda — 44 dos 113 statements `*:effect:*` do dataset
    // têm essa forma. Tratá-los como cobertos os faria avaliar FALSO.
    const ro = rollOptionsFor({ self: { effects: ["overdrive-success"] } });
    expect(coversStatement(ro, "self:effect:overdrive-success")).toBe(true);
    expect(coversStatement(ro, "self:effect:overdrive-success:2")).toBe(false);
    expect(evaluate("self:effect:overdrive-success:2", ro).value).toBe("unknown");
  });

  it("efeito em INIMIGO não é coberto — o registro só cobre o jogador", () => {
    const ro = rollOptionsFor({ self: { effects: ["panache"] }, target: { kind: "enemy" } });
    expect(evaluate("target:effect:panache", ro).value).toBe("unknown");
  });
});

describe.skipIf(!hasGenerated)("o feat que dependia de efeito ativo", () => {
  // Swashbuckler's Speed: +10 status em all-speeds COM panache, +5 SEM. É o par
  // que prova a lógica de três valores num único feat real.
  const c = mkCharacter({ feats: ["Swashbuckler's Speed"] });

  it("com o efeito ativo, aplica o bônus MAIOR", () => {
    const ro = rollOptionsForCheck({ character: c, effects: [eff("Effect: Panache")] });
    const { applied } = actorModifiersFor(c, "all-speeds", ro);
    // O slug vem do dado, e o pf2e distingue os dois ramos por ele.
    expect(applied).toEqual([
      { slug: "swashbucklers-speed-panache", type: "status", value: 10, source: "Swashbuckler's Speed" },
    ]);
  });

  it("sem o efeito (e sabendo disso), aplica o MENOR", () => {
    const ro = rollOptionsForCheck({ character: c, effects: [] });
    expect(actorModifiersFor(c, "all-speeds", ro).applied).toEqual([
      {
        slug: "swashbucklers-speed-no-panache",
        type: "status",
        value: 5,
        source: "Swashbuckler's Speed",
      },
    ]);
  });

  it("sem saber, NENHUM dos dois entra", () => {
    // Antes da Fase 2.6 este era o único resultado possível: os dois ramos
    // indecidíveis, o feat inteiro inerte.
    const ro = rollOptionsForCheck({ character: c });
    const { applied, skipped } = actorModifiersFor(c, "all-speeds", ro);
    expect(applied).toEqual([]);
    expect(skipped.every((s) => s.reason === "predicate-unknown")).toBe(true);
    expect(skipped).toHaveLength(2);
  });

  it("penalidade de efeito também vale — não só bônus", () => {
    // Barbarian Dedication: -1 de CA enquanto enfurecido. Predicado, então passa
    // pelo portão de não-duplo-cômputo (a CA da ficha não embute o situacional).
    const barb = mkCharacter({ feats: ["Barbarian Dedication"] });
    const raging = rollOptionsForCheck({ character: barb, effects: [eff("Effect: Rage")] });
    expect(actorModifiersFor(barb, "ac", raging).applied).toEqual([
      { slug: "barbarian-dedication", type: "untyped", value: -1, source: "Barbarian Dedication" },
    ]);
    const calm = rollOptionsForCheck({ character: barb, effects: [] });
    expect(actorModifiersFor(barb, "ac", calm).applied).toEqual([]);
  });
});

describe.skipIf(!hasGenerated)("os modificadores DO PRÓPRIO efeito", () => {
  const c = mkCharacter();

  it("o FlatModifier do effect entra na rolagem", () => {
    // Spell Effect: Bless — attack-roll, status +1, valor numérico.
    const ro = rollOptionsForCheck({ character: c, effects: [eff("Spell Effect: Bless")] });
    const { applied } = actorModifiersFor(c, "attack-roll", ro, [{ name: "Spell Effect: Bless" }]);
    expect(applied).toEqual([
      { slug: "bless", type: "status", value: 1, source: "Spell Effect: Bless" },
    ]);
  });

  it("INCONDICIONAL de efeito aplica onde o de FICHA não aplicaria", () => {
    // A regra de não-duplo-cômputo vale para a ficha, não para o efeito: a CA do
    // Pathbuilder não pode embutir um efeito que só existiu em jogo.
    const effects = [{ name: "Effect: Activate Defenses" }];
    const ro = rollOptionsForCheck({ character: c, effects: [eff("Effect: Activate Defenses")] });
    const { applied } = actorModifiersFor(c, "ac", ro, effects);
    // Sem `slug` no rule element, cai no slug do doc — prefixo incluído.
    expect(applied).toEqual([
      {
        slug: "effect-activate-defenses",
        type: "circumstance",
        value: 2,
        source: "Effect: Activate Defenses",
      },
    ]);
    // O MESMO seletor, vindo de feat incondicional, segue presumido na ficha.
    const withFeat = mkCharacter({ feats: ["Nimble Elf"] });
    expect(actorModifiersFor(withFeat, "land-speed").applied).toEqual([]);
  });

  it("valor por expressão fica DECLARADO, não vira número chutado", () => {
    // Spell Effect: Heroism vale `ternary(gte(@item.level,9),3,...)` — depende do
    // rank com que foi conjurado, que não resolvemos.
    const effects = [{ name: "Spell Effect: Heroism" }];
    const ro = rollOptionsForCheck({ character: c, effects: [eff("Spell Effect: Heroism")] });
    const { applied, skipped } = actorModifiersFor(c, "perception", ro, effects);
    expect(applied).toEqual([]);
    expect(skipped).toEqual([
      {
        source: "Spell Effect: Heroism",
        slug: "spell-effect-heroism",
        reason: "value-unresolved",
        detail: "ternary(gte(@item.level,9),3,ternary(gte(@item.level,6),2,1))",
      },
    ]);
  });

  it("efeito e condição empilham pela regra do PF2e", () => {
    const effects = [{ name: "Spell Effect: Bless" }];
    const ro = rollOptionsForCheck({ character: c, effects: [eff("Spell Effect: Bless")] });
    const fromEffect = actorModifiersFor(c, "attack-roll", ro, effects).applied;
    // Bless é status +1; outro status +1 não somaria, um circumstance somaria.
    const stack = new ModifierStack()
      .addAll(fromEffect)
      .addAll([{ slug: "x", type: "status", value: 1, source: "outro" }]);
    expect(stack.total()).toBe(1);
    expect(
      new ModifierStack()
        .addAll(fromEffect)
        .addAll([{ slug: "y", type: "circumstance", value: 1, source: "outro" }])
        .total(),
    ).toBe(2);
  });

  it("efeito nenhum ativo não muda nada", () => {
    expect(actorModifiersFor(c, "attack-roll", rollOptionsForCheck({ character: c }), []).applied).toEqual([]);
  });
});

describe.skipIf(!hasGenerated)("as defesas do efeito", () => {
  const c = mkCharacter();

  it("resistência de efeito entra com tipo e valor reais", () => {
    const effects = [{ name: "Effect: Cloak in Embers" }];
    const { defenses } = actorDefensesFor(c, rollOptionsForCheck({ character: c }), effects);
    expect(defenses.resistances).toEqual([{ type: "fire", value: 10 }]);
  });

  it("ficha e efeito na MESMA pilha: do mesmo tipo vale a maior", () => {
    // Inured to the Heat dá fire 4; Cloak in Embers dá fire 10. RAW: não somam.
    const hot = mkCharacter({ feats: ["Inured to the Heat"] });
    const { defenses } = actorDefensesFor(hot, rollOptionsForCheck({ character: hot }), [
      { name: "Effect: Cloak in Embers" },
    ]);
    expect(defenses.resistances).toEqual([{ type: "fire", value: 10 }]);
  });

  it("fraqueza de efeito também entra", () => {
    const { defenses } = actorDefensesFor(c, rollOptionsForCheck({ character: c }), [
      { name: "Effect: Brand of the Impenitent" },
    ]);
    expect(defenses.weaknesses).toEqual([{ type: "holy", value: 2 }]);
  });

  it("sem efeito, as defesas são as mesmas de antes da fase", () => {
    expect(actorDefensesFor(c, rollOptionsForCheck({ character: c }), []).defenses).toEqual({});
  });
});
