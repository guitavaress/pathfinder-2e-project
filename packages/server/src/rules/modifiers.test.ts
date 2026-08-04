import { describe, expect, it } from "vitest";
import { ModifierStack, modifierType, stackTotal, type Modifier } from "./modifiers.js";

const m = (slug: string, type: Modifier["type"], value: number): Modifier => ({
  slug,
  type,
  value,
});

describe("empilhamento por tipo (RAW)", () => {
  it("de cada tipo vale só a PIOR penalidade, não a soma", () => {
    // O erro que a aritmética ingênua cometia: frightened 2 + sickened 3 = -5.
    const s = new ModifierStack()
      .add(m("frightened", "status", -2))
      .add(m("sickened", "status", -3));
    expect(s.total()).toBe(-3);
    expect(s.suppressed().map((x) => x.slug)).toEqual(["frightened"]);
  });

  it("de cada tipo vale só o MAIOR bônus", () => {
    const s = new ModifierStack()
      .add(m("heroism", "status", 2))
      .add(m("bless", "status", 1));
    expect(s.total()).toBe(2);
  });

  it("tipos DIFERENTES somam entre si", () => {
    const s = new ModifierStack()
      .add(m("off-guard", "circumstance", -2))
      .add(m("frightened", "status", -2));
    expect(s.total()).toBe(-4);
    expect(s.suppressed()).toEqual([]);
  });

  it("bônus e penalidade do mesmo tipo convivem — um de cada", () => {
    const s = new ModifierStack()
      .add(m("cover", "circumstance", 2))
      .add(m("off-guard", "circumstance", -2))
      .add(m("outro", "circumstance", -1));
    expect(s.total()).toBe(0); // +2 e -2 valem; o -1 é suprimido
    expect(s.suppressed().map((x) => x.slug)).toEqual(["outro"]);
  });

  it("untyped SEMPRE soma, inclusive entre si", () => {
    const s = new ModifierStack()
      .add(m("a", "untyped", -1))
      .add(m("b", "untyped", -1))
      .add(m("c", "status", -2));
    expect(s.total()).toBe(-4);
  });

  it("empate mantém o primeiro — ordem do documento, sem sorteio", () => {
    const s = new ModifierStack()
      .add(m("primeiro", "status", -2))
      .add(m("segundo", "status", -2));
    expect(s.applied().map((x) => x.slug)).toEqual(["primeiro"]);
  });

  it("modificador zero não entra na pilha", () => {
    const s = new ModifierStack().add(m("nada", "status", 0));
    expect(s.applied()).toEqual([]);
    expect(s.total()).toBe(0);
  });

  it("pilha vazia é 0, nunca -0", () => {
    expect(Object.is(new ModifierStack().total(), 0)).toBe(true);
  });
});

describe("breakdown", () => {
  it("explica o número para o resumo mecânico", () => {
    const s = new ModifierStack()
      .add(m("off-guard", "circumstance", -2))
      .add({ slug: "frightened", type: "status", value: -2, source: "frightened 2" });
    expect(s.breakdown()).toBe("-2 circumstance (off-guard), -2 status (frightened 2)");
  });
});

describe("modifierType", () => {
  it("reconhece os tipos do PF2e e trata o resto como untyped", () => {
    expect(modifierType("circumstance")).toBe("circumstance");
    expect(modifierType("STATUS")).toBe("status");
    expect(modifierType("item")).toBe("item");
    // `ability` e `proficiency` passaram a ser tipos PRÓPRIOS na T5.3: os feats
    // da ficha os usam, e dobrá-los em untyped os faria somar entre si.
    expect(modifierType("ability")).toBe("ability");
    expect(modifierType("proficiency")).toBe("proficiency");
    // Encumbered vem do dado SEM type — untyped soma, e é isso mesmo.
    expect(modifierType(undefined)).toBe("untyped");
    expect(modifierType("inventado")).toBe("untyped");
  });

  it("dois bônus de `ability` não somam entre si", () => {
    const s = new ModifierStack()
      .add({ slug: "a", type: "ability", value: 2 })
      .add({ slug: "b", type: "ability", value: 3 });
    expect(s.total()).toBe(3);
  });
});

describe("stackTotal", () => {
  it("é o atalho de quem só quer o número", () => {
    expect(stackTotal([m("a", "status", -2), m("b", "status", -3)])).toBe(-3);
  });
});
