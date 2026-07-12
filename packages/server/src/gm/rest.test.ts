import { describe, expect, it } from "vitest";
import type { Character } from "@pf2e/shared";
import { executeTool } from "./agent.js";
import type { Session } from "./sessions.js";

const noop = () => {};

function mkCharacter(over: Partial<Record<string, unknown>> = {}): Character {
  return {
    name: "Jão",
    level: 5,
    maxHp: 65,
    ac: 22,
    perception: 11,
    abilityModifiers: { str: 0, dex: 4, con: 2, int: 0, wis: 1, cha: 2 },
    saves: { fortitude: 11, reflex: 15, will: 10 },
    weapons: [],
    armor: [],
    feats: [],
    classFeatures: [],
    equipment: [],
    skills: {},
    lores: [],
    spellcasting: [],
    ...over,
  } as unknown as Character;
}

function mkSession(hp: number, character = mkCharacter()): Session {
  return {
    id: "t",
    character,
    state: {
      sessionId: "t",
      currentHp: hp,
      conditions: [],
      flags: {},
      combat: null,
      spellSlotsUsed: { "3": 2 },
      focusPointsUsed: 1,
    },
  } as unknown as Session;
}

describe("rest (regras reais de descanso)", () => {
  it("overnight: cura CON×nível, restaura slots/focus e o dia passa", async () => {
    const s = mkSession(20);
    const out = await executeTool(s, "rest", { kind: "overnight" }, noop);
    // CON +2 × nível 5 = 10.
    expect(s.state.currentHp).toBe(30);
    expect(s.state.spellSlotsUsed).toBeUndefined();
    expect(s.state.focusPointsUsed).toBeUndefined();
    expect(out.summaryLine).toContain("recovers 10 HP");
  });

  it("overnight: CON negativa cura no mínimo 1×nível e capa no maxHp", async () => {
    const weak = mkCharacter({ abilityModifiers: { str: 0, dex: 4, con: -1, int: 0, wis: 1, cha: 2 } });
    const s = mkSession(62, weak);
    await executeTool(s, "rest", { kind: "overnight" }, noop);
    // min(1) × 5 = 5, capado em 65.
    expect(s.state.currentHp).toBe(65);
  });

  it("overnight: remove fatigued e decrementa drained", async () => {
    const s = mkSession(20);
    s.state.conditions = ["fatigued", "drained 2", "wounded 1"];
    await executeTool(s, "rest", { kind: "overnight" }, noop);
    expect(s.state.conditions).not.toContain("fatigued");
    expect(s.state.conditions).toContain("drained 1");
  });

  it("treat_wounds: exige Medicine treinado", async () => {
    const s = mkSession(20);
    const out = await executeTool(s, "rest", { kind: "treat_wounds" }, noop);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("TRAINED Medicine");
    expect(s.state.currentHp).toBe(20);
  });

  it("treat_wounds: exige healer's toolkit no Equipment", async () => {
    const c = mkCharacter({
      skills: { medicine: { name: "Medicine", ability: "wis", rank: 1, modifier: 8 } },
    });
    const s = mkSession(20, c);
    const out = await executeTool(s, "rest", { kind: "treat_wounds" }, noop);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("healer's toolkit");
  });

  it("treat_wounds: com requisitos, rola Medicine e o HP só sobe/cai nos limites das regras", async () => {
    const c = mkCharacter({
      skills: { medicine: { name: "Medicine", ability: "wis", rank: 2, modifier: 12 } },
      equipment: [{ name: "Healer's Toolkit", qty: 1 }],
    });
    const s = mkSession(20, c);
    const out = await executeTool(s, "rest", { kind: "treat_wounds" }, noop);
    expect(out.isError).toBeUndefined();
    // crit 4d8 (máx 32) / sucesso 2d8 / falha 0 / crit falha −1d8.
    expect(s.state.currentHp).toBeGreaterThanOrEqual(12);
    expect(s.state.currentHp).toBeLessThanOrEqual(52);
    expect(out.summaryLine).toContain("Treat Wounds");
  });

  it("descansar em combate é ilegal", async () => {
    const s = mkSession(20);
    s.state.combat = {
      active: true, round: 1, turnIndex: 0,
      combatants: [],
    } as unknown as Session["state"]["combat"];
    const out = await executeTool(s, "rest", { kind: "overnight" }, noop);
    expect(out.isError).toBe(true);
    expect(s.state.currentHp).toBe(20);
  });

  it("update_state com hpDelta positivo fora de combate é rejeitado apontando o rest", async () => {
    const s = mkSession(20);
    const out = await executeTool(s, "update_state", { hpDelta: 15 }, noop);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("rest");
    expect(s.state.currentHp).toBe(20);
  });

  it("update_state com hpDelta negativo (armadilha) segue funcionando", async () => {
    const s = mkSession(20);
    const out = await executeTool(s, "update_state", { hpDelta: -8 }, noop);
    expect(out.isError).toBeUndefined();
    expect(s.state.currentHp).toBe(12);
  });
});
