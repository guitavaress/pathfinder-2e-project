/**
 * As condições da engine agora VÊM do dado (Fase 2.5 / T4).
 *
 * O teste anterior era um alarme: comparava as constantes hard-coded de
 * `combat.ts` com o dado oficial e quebrava se divergissem. Ficou redundante
 * por construção — não há duas fontes para divergirem. O que se testa aqui é a
 * leitura: quais rule elements viram modificador, com que tipo e valor, e o que
 * fica DECLARADO por não ser resolvível.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  conditionModifiers,
  conditionModifiersFor,
  splitConditionName,
} from "./condition-modifiers.js";
import { ModifierStack } from "./modifiers.js";
import { rollOptionsFor } from "./roll-options.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));

const total = (conds: string[], sel: "ac" | "attack-roll") =>
  new ModifierStack().addAll(conditionModifiersFor(conds, sel)).total();

describe("splitConditionName", () => {
  it("separa nome e valor, com 1 implícito", () => {
    expect(splitConditionName("frightened 2")).toEqual({ name: "frightened", value: 2 });
    expect(splitConditionName("Off-Guard")).toEqual({ name: "off-guard", value: 1 });
  });
});

describe.skipIf(!hasGenerated)("condições lidas do dado oficial", () => {
  it("off-guard e frightened dão os MESMOS números de antes da T4", () => {
    // Prova de que trocar a fonte não mexeu no que a engine já fazia.
    expect(total(["off-guard"], "ac")).toBe(-2);
    expect(total(["frightened 2"], "ac")).toBe(-2);
    expect(total(["frightened 3"], "attack-roll")).toBe(-3);
    expect(total([], "ac")).toBe(0);
  });

  it("off-guard é circunstância e frightened é status — por isso somam", () => {
    const mods = conditionModifiersFor(["off-guard", "frightened 2"], "ac");
    expect(mods.map((m) => m.type).sort()).toEqual(["circumstance", "status"]);
    expect(total(["off-guard", "frightened 2"], "ac")).toBe(-4);
  });

  it("dois status NÃO somam: vale a pior", () => {
    expect(total(["frightened 2", "sickened 3"], "ac")).toBe(-3);
  });

  it("condições que a engine ignorava passam a valer", () => {
    // Nenhuma destas era aplicada antes da T4 — a engine só sabia de
    // off-guard e frightened.
    expect(total(["fatigued"], "ac")).toBe(-1);
    expect(total(["unconscious"], "ac")).toBe(-4);
    expect(total(["sickened 2"], "ac")).toBe(-2);
    expect(total(["prone"], "attack-roll")).toBe(-2);
  });

  it("seletor manda: prone penaliza o ataque, não a CA", () => {
    expect(total(["prone"], "ac")).toBe(0);
    expect(total(["prone"], "attack-roll")).toBe(-2);
  });

  it("`all` no dado cobre CA e ataque; seletor específico não", () => {
    expect(total(["sickened 2"], "attack-roll")).toBe(-2); // selector "all"
    expect(total(["unconscious"], "attack-roll")).toBe(0); // selector ["ac",...]
  });

  it("condição sem FlatModifier não inventa modificador", () => {
    expect(conditionModifiersFor(["fleeing"], "ac")).toEqual([]);
    expect(conditionModifiers("NomeInventado")).toEqual([]);
    // Nem a pseudo-condição que a própria engine grava.
    expect(conditionModifiersFor(["persistent fire damage 1d6"], "ac")).toEqual([]);
  });

  it("valor não resolvível fica DECLARADO e não é aplicado", () => {
    // Drained tem `min(-1 * @actor.level,-1) * @item.badge.value` no seletor hp:
    // expressão que não sabemos avaliar. Declarar é honesto; chutar não.
    const drained = conditionModifiers("Drained");
    const hp = drained.find((m) => m.selectors.includes("hp"));
    expect(hp?.unresolved).toBe("min(-1 * @actor.level,-1) * @item.badge.value");
    expect(hp?.value).toBeNull();
  });

  it("predicado não seguramente verdadeiro NÃO aplica", () => {
    // Deafened só penaliza perícia auditiva / iniciativa por percepção. Sem
    // contexto de rolagem, fica de fora — indecidível não é permissão (T3).
    const deafened = conditionModifiers("Deafened");
    expect(deafened[0]?.predicate).toBeDefined();
    expect(conditionModifiersFor(["deafened"], "ac", rollOptionsFor({}))).toEqual([]);
  });

  it("selector vem sempre como lista, seja string ou array no dado", () => {
    expect(conditionModifiers("Off-Guard")[0]?.selectors).toEqual(["ac"]);
    expect(conditionModifiers("Fatigued")[0]?.selectors).toEqual(["ac", "saving-throw"]);
  });
});
