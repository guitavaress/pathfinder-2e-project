import { describe, expect, it } from "vitest";
import type { Character, Combatant } from "@pf2e/shared";
import { executeTool } from "./agent.js";
import type { Session } from "./sessions.js";

const noop = () => {};

function mkCharacter(): Character {
  return {
    name: "Hero",
    level: 5,
    maxHp: 50,
    ac: 20,
    perception: 10,
    abilityModifiers: { str: 0, dex: 4, con: 2, int: 0, wis: 1, cha: 0 },
    weapons: [{ name: "Dagger", attack: 13, die: "d4", damageBonus: 0, damageType: "P" }],
    armor: [],
    feats: [],
    classFeatures: [],
    equipment: [],
    skills: {},
    lores: [],
  } as unknown as Character;
}

function mkSession(): Session {
  return {
    id: "t",
    character: mkCharacter(),
    state: { sessionId: "t", currentHp: 50, conditions: [], flags: {}, combat: null },
  } as unknown as Session;
}

const enemies = (s: Session): Combatant[] =>
  s.state.combat!.combatants.filter((c) => c.kind === "enemy");

describe("start_combat com orçamento de encontro (party de 1, PC level 5)", () => {
  it("caso real 2026-07-11: 3× thug lvl 1 + hound lvl 2 em extreme → hound cortado", async () => {
    const s = mkSession();
    const out = await executeTool(
      s,
      "start_combat",
      {
        difficulty: "extreme",
        enemies: [
          { name: "Thug", level: 1, count: 3 },
          { name: "Scavenger Hound", level: 2, count: 1 },
        ],
      },
      noop,
    );
    // 3× 10 XP = 30 cabem; o hound (15) estouraria os 40 do extreme solo.
    expect(enemies(s).map((c) => c.name).sort()).toEqual(["Thug 1", "Thug 2", "Thug 3"]);
    expect(out.summaryLine).toMatch(/Encounter: \w+ \(\d+\/\d+ XP\)/);
    expect(out.summaryLine).toContain("Encounter: severe (30/30 XP)");
    expect(out.summaryLine).toContain("dropped 1× Scavenger Hound");
  });

  it("default moderate + anti-vazio: 1 inimigo on-level é rebaixado, nunca combate vazio", async () => {
    const s = mkSession();
    const out = await executeTool(
      s,
      "start_combat",
      { enemies: [{ name: "Ogre", level: 5, count: 1 }] },
      noop,
    );
    // lvl 5 = 40 XP > moderate solo 20 → rebaixado para lvl 3 (20 XP).
    const foes = enemies(s);
    expect(foes).toHaveLength(1);
    expect(foes[0]!.level).toBe(3);
    expect(out.summaryLine).toContain("weakened from level 5 to 3");
  });

  it("PL+5 nunca entra, mesmo em extreme", async () => {
    const s = mkSession();
    const out = await executeTool(
      s,
      "start_combat",
      {
        difficulty: "extreme",
        enemies: [
          { name: "Ancient Dragon", level: 10, count: 1 },
          { name: "Kobold", level: 1, count: 1 },
        ],
      },
      noop,
    );
    expect(enemies(s).map((c) => c.name)).toEqual(["Kobold"]);
    expect(out.summaryLine).toContain("forbidden: Ancient Dragon (level 10 > party level +4)");
  });

  it("reforços: entram até o teto e o resumo re-classifica o encontro", async () => {
    const s = mkSession();
    await executeTool(
      s,
      "start_combat",
      { difficulty: "extreme", enemies: [{ name: "Thug", level: 1, count: 3 }] },
      noop,
    );
    const out = await executeTool(
      s,
      "start_combat",
      { difficulty: "extreme", enemies: [{ name: "Wolf", level: 1, count: 1 }] },
      noop,
    );
    // 30 XP em campo + 10 do lobo = 40 ≤ extreme 40 → entra.
    expect(enemies(s).map((c) => c.name).sort()).toEqual(["Thug 1", "Thug 2", "Thug 3", "Wolf"]);
    expect(out.summaryLine).toContain("Reinforcements join the fight: Wolf");
    expect(out.summaryLine).toMatch(/Encounter now: extreme \(40\/40 XP\)/);
  });

  it("reforços acima do teto NÃO entram — e inimigo derrotado ainda conta (anti-onda)", async () => {
    const s = mkSession();
    await executeTool(
      s,
      "start_combat",
      { difficulty: "extreme", enemies: [{ name: "Thug", level: 1, count: 4 }] },
      noop,
    );
    // 40/40 XP: teto. Derrotar um thug não libera orçamento — é UM encontro.
    const down = enemies(s)[0]!;
    down.defeated = true;
    down.currentHp = 0;
    const before = s.state.combat!.combatants.length;
    const out = await executeTool(
      s,
      "start_combat",
      { difficulty: "extreme", enemies: [{ name: "Wolf", level: 1, count: 2 }] },
      noop,
    );
    expect(s.state.combat!.combatants).toHaveLength(before);
    expect(out.content).toContain("exceed the encounter budget");
    expect(out.summaryLine).toContain("none joined");
  });

  it("difficulty desconhecida vira moderate, sem crash", async () => {
    const s = mkSession();
    const out = await executeTool(
      s,
      "start_combat",
      { difficulty: "impossible", enemies: [{ name: "Thug", level: 1, count: 2 }] },
      noop,
    );
    // 2× 10 = 20 XP = exatamente o moderate solo.
    expect(enemies(s)).toHaveLength(2);
    expect(out.summaryLine).toContain("Encounter: moderate (20/20 XP)");
  });
});
