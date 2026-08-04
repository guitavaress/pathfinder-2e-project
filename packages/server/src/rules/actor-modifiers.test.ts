/**
 * Os modificadores da ficha vindos do DADO (Fase 2.5 / T5.3).
 *
 * Os casos usam feats REAIS do dataset, com os valores que o pf2e publica — não
 * fixtures inventadas. É o que torna o teste uma prova de que a engine lê o
 * dado, e não uma prova de que ela concorda consigo mesma.
 *
 * O que mais importa aqui é o que NÃO é aplicado: o modificador incondicional
 * que o Pathbuilder já somou, e o predicado que o contexto não decide.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Character } from "@pf2e/shared";
import {
  actorDefensesFor,
  actorModifiersFor,
  ENGINE_COMPOSED_SELECTORS,
} from "./actor-modifiers.js";
import { ModifierStack } from "./modifiers.js";
import { rollOptionsFor } from "./roll-options.js";
import { rollOptionsForCheck } from "./roll-context.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));

function mkCharacter(over: Partial<Character> = {}): Character {
  return {
    name: "Jão",
    level: 5,
    ancestry: "Human",
    heritage: null,
    background: "Hunter",
    className: "Fighter",
    feats: [],
    classFeatures: [],
    skills: {},
    lores: [],
    ...over,
  } as unknown as Character;
}

const slugs = (mods: { slug: string }[]) => mods.map((m) => m.slug).sort();

describe.skipIf(!hasGenerated)("actorModifiersFor — o que APLICA", () => {
  it("iniciativa: o feat que a engine hard-codava agora vem do dado", () => {
    // `PASSIVE_FEAT_EFFECTS` tinha exatamente esta linha escrita à mão.
    const c = mkCharacter({ feats: ["Incredible Initiative"] });
    const { applied } = actorModifiersFor(c, "initiative");
    expect(applied).toEqual([
      {
        slug: "incredible-initiative",
        type: "circumstance",
        value: 2,
        source: "Incredible Initiative",
      },
    ]);
  });

  it("predicado de AÇÃO decidido pelo contexto aplica", () => {
    // Natural Climber: +2 circunstância em Athletics, `["action:climb"]`.
    const c = mkCharacter({ feats: ["Natural Climber"] });
    const climbing = rollOptionsForCheck({ character: c, action: "Climb" });
    expect(actorModifiersFor(c, "athletics", climbing).applied).toEqual([
      { slug: "natural-climber", type: "circumstance", value: 2, source: "Natural Climber" },
    ]);
  });

  it("a MESMA rolagem em outra ação não recebe o bônus", () => {
    const c = mkCharacter({ feats: ["Natural Climber"] });
    const shoving = rollOptionsForCheck({ character: c, action: "Shove" });
    const { applied, skipped } = actorModifiersFor(c, "athletics", shoving);
    expect(applied).toEqual([]);
    expect(skipped).toEqual([
      { source: "Natural Climber", slug: "natural-climber", reason: "predicate-false" },
    ]);
  });

  it("predicado sobre traço do efeito decide pelo item em jogo", () => {
    // Emotionless: +1 circunstância em saves contra `emotion` ou `fear`.
    const c = mkCharacter({ feats: ["Emotionless"] });
    const vsFear = rollOptionsFor({ item: { traits: ["fear"] } });
    expect(slugs(actorModifiersFor(c, "saving-throw", vsFear).applied)).toEqual(["emotionless"]);
    const vsFire = rollOptionsFor({ item: { traits: ["fire"] } });
    expect(actorModifiersFor(c, "saving-throw", vsFire).applied).toEqual([]);
  });

  it("herança e ancestralidade contam como fonte, não só feats", () => {
    const c = mkCharacter({ ancestry: "Poppet", feats: [] });
    const vsPoison = rollOptionsFor({ item: { traits: ["poison"] } });
    // "Constructed" é feature de ancestralidade do Poppet no dado.
    const withFeature = mkCharacter({ ancestry: "Poppet", classFeatures: ["Constructed"] });
    expect(actorModifiersFor(c, "saving-throw", vsPoison).applied).toEqual([]);
    expect(slugs(actorModifiersFor(withFeature, "saving-throw", vsPoison).applied)).toContain(
      "constructed",
    );
  });
});

describe.skipIf(!hasGenerated)("actorModifiersFor — o que NÃO aplica, e por quê", () => {
  it("sem contexto de rolagem, predicado nenhum passa", () => {
    const c = mkCharacter({ feats: ["Natural Climber"] });
    const { applied, skipped } = actorModifiersFor(c, "athletics");
    expect(applied).toEqual([]);
    expect(skipped[0]).toMatchObject({ reason: "predicate-unknown" });
  });

  it("incondicional em seletor da FICHA é presumido já somado pelo Pathbuilder", () => {
    // Nimble Elf: +5 land-speed, sem predicado. `character.speed` já vem final
    // do export — aplicar de novo andaria 5 pés a mais por engano.
    const c = mkCharacter({ ancestry: "Elf", feats: ["Nimble Elf"] });
    const { applied, skipped } = actorModifiersFor(c, "land-speed");
    expect(applied).toEqual([]);
    expect(skipped).toEqual([
      { source: "Nimble Elf", slug: "nimble-elf", reason: "assumed-in-sheet" },
    ]);
  });

  it("Toughness não soma HP duas vezes", () => {
    // O maxHp do Pathbuilder já inclui Toughness — e o valor no dado é
    // `@actor.level`, expressão que não resolvemos. Dois motivos para ficar fora.
    const c = mkCharacter({ feats: ["Toughness"] });
    const { applied, skipped } = actorModifiersFor(c, "hp");
    expect(applied).toEqual([]);
    expect(skipped).toEqual([{ source: "Toughness", slug: "toughness", reason: "assumed-in-sheet" }]);
  });

  it("expressão não resolvida em seletor da engine fica DECLARADA", () => {
    // Se o seletor for composto pela engine, o incondicional passa do primeiro
    // portão — e aí é o valor que barra, com a expressão crua registrada.
    const composed = [...ENGINE_COMPOSED_SELECTORS];
    expect(composed).toContain("initiative");
    expect(composed).not.toContain("hp");
  });

  it("feat que a ficha não tem não entra", () => {
    const c = mkCharacter({ feats: [] });
    expect(actorModifiersFor(c, "initiative").applied).toEqual([]);
    expect(actorModifiersFor(c, "initiative").skipped).toEqual([]);
  });

  it("nome inventado na ficha não quebra nem inventa modificador", () => {
    const c = mkCharacter({ feats: ["Golpe do Dragão Interior"] });
    expect(actorModifiersFor(c, "athletics", rollOptionsFor({}))).toEqual({
      applied: [],
      skipped: [],
    });
  });
});

describe.skipIf(!hasGenerated)("actorModifiersFor — empilhamento", () => {
  it("dois bônus de circunstância disparam juntos e NÃO somam", () => {
    // Affliction Resistance e Constructed dão ambos +1 de CIRCUNSTÂNCIA em
    // saves contra veneno. Os dois se aplicam de verdade — e a pilha do PF2e
    // mantém só um. Aritmética ingênua daria +2.
    const c = mkCharacter({ feats: ["Affliction Resistance", "Constructed"] });
    const vsPoison = rollOptionsFor({ item: { traits: ["poison"] } });
    const { applied } = actorModifiersFor(c, "saving-throw", vsPoison);
    expect(applied).toHaveLength(2);
    expect(new ModifierStack().addAll(applied).total()).toBe(1);
  });

  it("circunstância e status somam entre si", () => {
    // Coral Symbiotes é STATUS +1 contra veneno; Constructed é circunstância.
    const c = mkCharacter({ feats: ["Constructed", "Coral Symbiotes"] });
    const vsPoison = rollOptionsFor({ item: { traits: ["poison"] } });
    const { applied } = actorModifiersFor(c, "saving-throw", vsPoison);
    expect(applied.map((m) => m.type).sort()).toEqual(["circumstance", "status"]);
    expect(new ModifierStack().addAll(applied).total()).toBe(2);
  });

  it("feat repetido na ficha conta uma vez só", () => {
    const c = mkCharacter({ feats: ["Incredible Initiative", "Incredible Initiative"] });
    expect(actorModifiersFor(c, "initiative").applied).toHaveLength(1);
  });
});

describe.skipIf(!hasGenerated)("actorDefensesFor — defesas tipadas do dado (T5.5)", () => {
  it("resistência de feat entra com tipo e valor reais", () => {
    const c = mkCharacter({ feats: ["Inured to the Heat"] });
    expect(actorDefensesFor(c).defenses).toEqual({ resistances: [{ type: "fire", value: 4 }] });
  });

  it("imunidade e fraqueza — que o Pathbuilder nem exporta", () => {
    const c = mkCharacter({ feats: ["Basic Undead Benefits", "Fey Skin"] });
    const { defenses } = actorDefensesFor(c);
    expect(defenses.immunities).toEqual(["death-effects"]);
    expect(defenses.weaknesses).toEqual([{ type: "cold-iron", value: 5 }]);
  });

  it("duas resistências do MESMO tipo não somam: vale a maior", () => {
    // RAW: resistências do mesmo tipo não empilham.
    const c = mkCharacter({ feats: ["Inured to the Heat", "Asmodeus - Moderate Boon"] });
    expect(actorDefensesFor(c).defenses.resistances).toEqual([{ type: "fire", value: 5 }]);
  });

  it("um mesmo feat pode dar resistência E fraqueza", () => {
    const c = mkCharacter({ feats: ["Become Thought"] });
    const { defenses } = actorDefensesFor(c);
    expect(defenses.resistances).toEqual([{ type: "physical", value: 10 }]);
    expect(defenses.weaknesses).toEqual([{ type: "mental", value: 5 }]);
  });

  it("tipo escolhido por ChoiceSet fica DECLARADO, não vira defesa vazia", () => {
    // Geb's Blessing: `{item|flags.pf2e.rulesSelections.energyOne}` depende de
    // uma escolha que a ficha do Pathbuilder não exporta.
    const c = mkCharacter({ feats: ["Geb's Blessing"] });
    const { defenses, skipped } = actorDefensesFor(c);
    expect(defenses).toEqual({});
    expect(skipped.every((s) => s.reason === "value-unresolved")).toBe(true);
    expect(skipped[0]?.detail).toContain("rulesSelections");
  });

  it("valor por expressão não vira número chutado", () => {
    // Advanced Undead Benefits: `floor(@actor.level/2)`.
    const c = mkCharacter({ feats: ["Advanced Undead Benefits"] });
    const { defenses, skipped } = actorDefensesFor(c);
    expect(defenses.resistances).toBeUndefined();
    expect(skipped.some((s) => s.detail === "floor(@actor.level/2)")).toBe(true);
  });

  it("predicado indecidível sem contexto não concede defesa", () => {
    // Os "Gates" do Kineticist exigem `self:effect:kinetic-aura` — efeito ativo,
    // que a engine não modela.
    const c = mkCharacter({ feats: ["Fire Gate"] });
    const { defenses, skipped } = actorDefensesFor(c, rollOptionsFor({}));
    expect(defenses.immunities).toBeUndefined();
    expect(skipped.some((s) => s.reason === "predicate-unknown")).toBe(true);
  });

  it("ficha sem nada não inventa defesa", () => {
    expect(actorDefensesFor(mkCharacter()).defenses).toEqual({});
  });
});
