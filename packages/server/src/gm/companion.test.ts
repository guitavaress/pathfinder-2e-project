/**
 * T1 da Fase 2 (ADR-004): a entidade Companion e sua metade mecânica pura —
 * builders, orçamento de encontro com party real e persistência no save.
 * Nada aqui toca modelo: companheiro é engine.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GameStateSchema, type Companion } from "@pf2e/shared";
import type { CreatureStatblock } from "../rules/dataset.js";
import {
  MAX_PARTY_SIZE,
  allyCombatant,
  benchmark,
  encounterBudget,
  newCompanion,
  partySizeOf,
  planEncounter,
} from "./combat.js";
import { loadSave, restoreIntoSession, saveSession } from "./save.js";
import { createSession } from "./sessions.js";
import { parsePathbuilder } from "../pathbuilder/parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const example = JSON.parse(
  readFileSync(join(here, "../../../../exemplo_personagem.json"), "utf8"),
);

function statblock(): CreatureStatblock & { sourceName: string; traits: string[] } {
  return {
    sourceName: "Guard Captain",
    traits: ["human", "humanoid"],
    ac: 21,
    hp: 45,
    perception: 12,
    saves: { fortitude: 11, reflex: 9, will: 8 },
    attacks: [],
    abilitiesList: [],
  };
}

describe("newCompanion", () => {
  it("com statblock real usa AC/HP/percepção/saves oficiais e guarda o sourceName", () => {
    const c = newCompanion("Sela", 3, "Guerreira seca e leal.", statblock());
    expect(c).toMatchObject({
      name: "Sela",
      level: 3,
      ac: 21,
      maxHp: 45,
      currentHp: 45,
      perception: 12,
      sourceName: "Guard Captain",
      saves: { fortitude: 11, reflex: 9, will: 8 },
      persona: "Guerreira seca e leal.",
    });
    expect(c.id).toHaveLength(8);
  });

  it("sem statblock cai no benchmark do nível (o mesmo caminho honesto do inimigo)", () => {
    const b = benchmark(2);
    const c = newCompanion("Tobin", 2, "Batedor tagarela.");
    expect(c).toMatchObject({ ac: b.ac, maxHp: b.hp, perception: b.perception });
    expect(c.sourceName).toBeUndefined();
  });

  it("statblock sem HP utilizável cai no benchmark (guard igual ao do inimigo)", () => {
    const broken = { ...statblock(), hp: 0 };
    const c = newCompanion("Sela", 3, "—", broken);
    expect(c.maxHp).toBe(benchmark(3).hp);
    expect(c.sourceName).toBeUndefined();
  });
});

describe("allyCombatant", () => {
  it("entra como kind ally, com o MESMO id do roster e HP/condições herdados", () => {
    const comp = newCompanion("Sela", 3, "—", statblock());
    comp.currentHp = 20;
    comp.conditions = ["frightened 1"];
    const ally = allyCombatant(comp);
    expect(ally.kind).toBe("ally");
    expect(ally.id).toBe(comp.id);
    expect(ally.currentHp).toBe(20);
    expect(ally.maxHp).toBe(45);
    expect(ally.conditions).toEqual(["frightened 1"]);
    expect(ally.sourceName).toBe("Guard Captain");
    expect(ally.defeated).toBe(false);
    // Iniciativa rolada: d20 + percepção.
    expect(ally.initiative).toBeGreaterThanOrEqual(13);
    expect(ally.initiative).toBeLessThanOrEqual(32);
  });

  it("companheiro a 0 HP entra DEFEATED — o roster não mente para o combate", () => {
    const comp = newCompanion("Sela", 3, "—", statblock());
    comp.currentHp = 0;
    expect(allyCombatant(comp).defeated).toBe(true);
  });

  it("mutação do combatente não vaza para o roster (arrays copiados)", () => {
    const comp = newCompanion("Sela", 3, "—", statblock());
    const ally = allyCombatant(comp);
    ally.conditions.push("prone");
    ally.traits.push("x");
    expect(comp.conditions).toEqual([]);
    expect(comp.traits).toEqual(["human", "humanoid"]);
  });
});

describe("orçamento de encontro com aliados", () => {
  it("partySizeOf conta jogador + aliados", () => {
    const comp = newCompanion("Sela", 3, "—");
    const combatants = [
      allyCombatant(comp),
      { ...allyCombatant(comp), kind: "player" as const },
      { ...allyCombatant(comp), kind: "enemy" as const },
    ];
    expect(partySizeOf(combatants)).toBe(2);
  });

  it("duo dobra o orçamento do solo (moderate 20 → 40 XP)", () => {
    expect(encounterBudget("moderate", 1)).toBe(20);
    expect(encounterBudget("moderate", 2)).toBe(40);
    // Um inimigo de nível igual (40 XP) não cabe no moderate solo, cabe no duo.
    const solo = planEncounter([{ name: "Ogro", level: 3, count: 1 }], 0, {
      partyLevel: 3,
      partySize: 1,
      difficulty: "moderate",
    });
    expect(solo.fits).toBe(false);
    const duo = planEncounter([{ name: "Ogro", level: 3, count: 1 }], 0, {
      partyLevel: 3,
      partySize: 2,
      difficulty: "moderate",
    });
    expect(duo.fits).toBe(true);
  });

  it("MAX_PARTY_SIZE é 4 (ADR-004)", () => {
    expect(MAX_PARTY_SIZE).toBe(4);
  });
});

describe("persistência de companheiros", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "companion-save-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("companheiros sobrevivem ao round-trip de save (com HP entre combates)", () => {
    const session = createSession(parsePathbuilder(example));
    const comp: Companion = newCompanion("Sela", 3, "Guerreira seca e leal.", statblock());
    comp.currentHp = 20;
    session.state.companions = [comp];
    saveSession(session, dir);

    const save = loadSave(dir);
    expect(save).not.toBeNull();
    const restored = createSession(save!.character);
    restoreIntoSession(restored, save!);
    expect(restored.state.companions).toHaveLength(1);
    expect(restored.state.companions![0]).toMatchObject({
      name: "Sela",
      currentHp: 20,
      persona: "Guerreira seca e leal.",
      sourceName: "Guard Captain",
    });
  });

  it("save antigo SEM companions continua válido (compat v1)", () => {
    const session = createSession(parsePathbuilder(example));
    const state = { ...session.state } as Record<string, unknown>;
    delete state.companions;
    const parsed = GameStateSchema.safeParse(state);
    expect(parsed.success).toBe(true);
    expect(parsed.data!.companions).toBeUndefined();
  });

  it("sessão nova nasce com roster vazio", () => {
    const session = createSession(parsePathbuilder(example));
    expect(session.state.companions).toEqual([]);
  });
});
