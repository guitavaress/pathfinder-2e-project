/**
 * Piloto de consumo de rule elements: as constantes hard-coded da engine
 * (combat.ts) são comparadas com o DADO oficial das condições. A engine não
 * muda de fonte — este teste é o alarme que dispara se código e dado
 * divergirem (ex.: num bump de ref do dataset).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Combatant } from "@pf2e/shared";
import { conditionModifiers } from "./condition-modifiers.js";
import { attackStatusPenalty, effectiveAC } from "../gm/combat.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));

function combatant(conditions: string[]): Combatant {
  return {
    id: "t",
    name: "T",
    kind: "enemy",
    initiative: 10,
    ac: 20,
    maxHp: 10,
    currentHp: 10,
    conditions,
    actionsRemaining: 3,
    reactionAvailable: true,
    mapProgress: 0,
    level: 1,
    defeated: false,
  } as unknown as Combatant;
}

describe.skipIf(!hasGenerated)("piloto: engine ⇔ dado oficial das condições", () => {
  it("off-guard: o dado diz circumstance -2 na CA — e a engine aplica -2 na CA", () => {
    const mods = conditionModifiers("Off-Guard");
    expect(mods).toEqual([
      { selector: "ac", type: "circumstance", value: -2, scalesWithValue: false },
    ]);
    // A engine, de forma independente:
    const delta = effectiveAC(combatant(["off-guard"])) - effectiveAC(combatant([]));
    expect(delta).toBe(mods[0]!.value);
  });

  it("frightened: o dado diz status -N em TUDO — e a engine aplica -N", () => {
    const mods = conditionModifiers("Frightened");
    expect(mods).toHaveLength(1);
    expect(mods[0]).toMatchObject({
      selector: "all",
      type: "status",
      scalesWithValue: true,
    });
    // "-N em tudo" cobre a CA do alvo e as rolagens do atacante — os dois
    // recortes que a engine implementa:
    const acDelta =
      effectiveAC(combatant(["frightened 2"])) - effectiveAC(combatant([]));
    expect(acDelta).toBe(-2);
    expect(attackStatusPenalty(combatant(["frightened 2"]))).toBe(-2);
    expect(attackStatusPenalty(combatant(["frightened 3"]))).toBe(-3);
  });

  it("condição sem FlatModifier devolve vazio (não inventa modificador)", () => {
    // Prone tem os efeitos via prosa/outros REs; o piloto só reporta o que HÁ.
    expect(Array.isArray(conditionModifiers("Fleeing"))).toBe(true);
    expect(conditionModifiers("NomeInventado")).toEqual([]);
  });
});
