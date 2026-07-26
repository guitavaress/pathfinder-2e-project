/**
 * T3 da Fase 2 (ADR-004): o turno do aliado resolvido em código e o revide
 * inimigo distribuído por round-robin. Espelha enemy-turn.test.ts —
 * determinístico onde dá (AC 1 / AC 100), invariantes onde há RNG.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Combatant, GameState } from "@pf2e/shared";
import { resolveAllyTurns, resolveEnemyTurns, runRulesStage } from "./agent.js";
import { buildCombat } from "./combat.js";
import type { Session } from "./sessions.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));

function mk(partial: Partial<Combatant> & Pick<Combatant, "name" | "kind">): Combatant {
  return {
    id: partial.name.toLowerCase().replace(/\s+/g, "-"),
    initiative: 10,
    ac: 15,
    maxHp: 40,
    currentHp: 40,
    conditions: [],
    actionsRemaining: 3,
    reactionAvailable: true,
    mapProgress: 0,
    level: 1,
    traits: [],
    defeated: false,
    ...partial,
  };
}

function sessionWith(...combatants: Combatant[]): Session {
  const combat = buildCombat(combatants);
  const player = combatants.find((c) => c.kind === "player")!;
  const state: GameState = {
    sessionId: "t",
    currentHp: player.currentHp,
    conditions: [],
    flags: {},
    combat,
  };
  return {
    id: "t",
    state,
    character: { name: player.name, maxHp: player.maxHp },
    messages: [],
  } as unknown as Session;
}

const noop = () => {};

describe("resolveAllyTurns", () => {
  it("aliado vivo faz 2 Strikes no inimigo, com MAP no segundo", () => {
    const player = mk({ name: "Hero", kind: "player" });
    const ally = mk({ name: "Sela", kind: "ally", level: 2 });
    const foe = mk({ name: "Foe", kind: "enemy", ac: 1, maxHp: 200, currentHp: 200 });
    const s = sessionWith(player, ally, foe);
    const lines = resolveAllyTurns(s, noop);
    expect(lines.filter((l) => l.includes("Sela Strike vs Foe")).length).toBe(2);
    expect(lines[1]).toContain("[MAP -5]");
    expect(foe.currentHp).toBeLessThan(200);
    // O turno do aliado nunca toca o estado do jogador.
    expect(s.state.currentHp).toBe(player.currentHp);
  });

  it("aliado derrotado não age; sem aliados é no-op", () => {
    const player = mk({ name: "Hero", kind: "player" });
    const down = mk({ name: "Sela", kind: "ally", defeated: true, currentHp: 0 });
    const foe = mk({ name: "Foe", kind: "enemy", ac: 1 });
    expect(resolveAllyTurns(sessionWith(player, down, foe), noop)).toEqual([]);
    expect(resolveAllyTurns(sessionWith(mk({ name: "H", kind: "player" }), foe), noop)).toEqual(
      [],
    );
  });

  it("aliados podem vencer a luta sozinhos (VICTORY fecha o combate)", () => {
    const player = mk({ name: "Hero", kind: "player" });
    const ally = mk({ name: "Sela", kind: "ally", level: 5 });
    const foe = mk({ name: "Foe", kind: "enemy", ac: 1, maxHp: 1, currentHp: 1 });
    const s = sessionWith(player, ally, foe);
    const lines = resolveAllyTurns(s, noop);
    expect(foe.defeated).toBe(true);
    expect(s.state.combat!.active).toBe(false);
    expect(lines.some((l) => l.includes("VICTORY"))).toBe(true);
    expect(lines.some((l) => l.includes("goes DOWN"))).toBe(true);
  });

  it("segundo Strike muda de alvo quando o primeiro derruba o inimigo", () => {
    const player = mk({ name: "Hero", kind: "player" });
    const ally = mk({ name: "Sela", kind: "ally", level: 5 });
    const a = mk({ name: "Foe A", kind: "enemy", ac: 1, maxHp: 1, currentHp: 1, initiative: 8 });
    const b = mk({ name: "Foe B", kind: "enemy", ac: 1, maxHp: 200, currentHp: 200, initiative: 6 });
    const s = sessionWith(player, ally, a, b);
    const lines = resolveAllyTurns(s, noop);
    expect(lines.some((l) => l.includes("vs Foe A"))).toBe(true);
    expect(lines.some((l) => l.includes("vs Foe B"))).toBe(true);
  });
});

describe("resolveEnemyTurns — revide distribuído", () => {
  it("SEM aliados: os 2 Strikes seguem no jogador (baseline intacto)", () => {
    const player = mk({ name: "Hero", kind: "player", ac: 1, maxHp: 200, currentHp: 200 });
    const s = sessionWith(player, mk({ name: "Foe", kind: "enemy" }));
    const lines = resolveEnemyTurns(s, noop);
    expect(lines.filter((l) => l.includes("Strike vs Hero")).length).toBe(2);
  });

  it("COM aliado: os golpes alternam entre os defensores (round-robin)", () => {
    // AC 100 nos dois: ninguém cai, dá para contar alvos com precisão.
    const player = mk({ name: "Hero", kind: "player", ac: 100, initiative: 20 });
    const ally = mk({ name: "Sela", kind: "ally", ac: 100, initiative: 15 });
    const foe = mk({ name: "Foe", kind: "enemy", initiative: 5 });
    const s = sessionWith(player, ally, foe);
    const lines = resolveEnemyTurns(s, noop);
    expect(lines.filter((l) => l.includes("vs Hero")).length).toBe(1);
    expect(lines.filter((l) => l.includes("vs Sela")).length).toBe(1);
  });

  it("aliado caído sai do rodízio; jogador caído idem (inimigos seguem nos vivos)", () => {
    const player = mk({ name: "Hero", kind: "player", ac: 100, initiative: 20 });
    const downed = mk({ name: "Sela", kind: "ally", defeated: true, currentHp: 0, initiative: 15 });
    const foe = mk({ name: "Foe", kind: "enemy", initiative: 5 });
    const s = sessionWith(player, downed, foe);
    const lines = resolveEnemyTurns(s, noop);
    expect(lines.filter((l) => l.includes("vs Hero")).length).toBe(2);
    expect(lines.some((l) => l.includes("vs Sela"))).toBe(false);
  });

  it("aliado a 0 HP fica DOWN — sem dying, sem tocar o estado do jogador", () => {
    const player = mk({ name: "Hero", kind: "player", ac: 100, initiative: 20 });
    const frail = mk({ name: "Sela", kind: "ally", ac: 1, maxHp: 2, currentHp: 2, initiative: 15 });
    const foe = mk({ name: "Foe", kind: "enemy", level: 5, initiative: 5 });
    const s = sessionWith(player, frail, foe);
    const lines = resolveEnemyTurns(s, noop);
    expect(frail.defeated).toBe(true);
    expect(lines.some((l) => l.includes("Sela goes DOWN"))).toBe(true);
    // Dying é subsistema do JOGADOR: aliado caído não gera condição na sessão.
    expect(s.state.conditions).toEqual([]);
    // Aliados vivos seguram o combate: sem DEFEAT enquanto o Hero está de pé.
    expect(s.state.combat!.active).toBe(true);
  });

  it("derrota SÓ quando todo o lado do jogador cai", () => {
    const player = mk({ name: "Hero", kind: "player", ac: 1, maxHp: 2, currentHp: 2, initiative: 20 });
    const ally = mk({ name: "Sela", kind: "ally", ac: 1, maxHp: 2, currentHp: 2, initiative: 15 });
    const foe = mk({ name: "Foe", kind: "enemy", level: 5, initiative: 5 });
    const s = sessionWith(player, ally, foe);
    const lines = resolveEnemyTurns(s, noop);
    expect(s.state.combat!.active).toBe(false);
    expect(lines.some((l) => l.includes("DEFEAT"))).toBe(true);
    expect(s.state.conditions.some((c) => /^dying/.test(c))).toBe(true);
  });
});

describe("jogador dying com aliados em campo (runRulesStage)", () => {
  function dyingSession(playerAc = 15): Session {
    const player = mk({
      name: "Hero",
      kind: "player",
      ac: playerAc,
      currentHp: 0,
      defeated: true,
      conditions: ["dying 1", "unconscious"],
      initiative: 20,
    });
    const ally = mk({ name: "Sela", kind: "ally", ac: 100, maxHp: 200, currentHp: 200, initiative: 15 });
    const foe = mk({ name: "Foe", kind: "enemy", ac: 1, maxHp: 500, currentHp: 500, initiative: 5 });
    const s = sessionWith(player, ally, foe);
    s.state.currentHp = 0;
    s.state.conditions = ["dying 1", "unconscious"];
    return s;
  }

  it("o turno é o recovery check E a luta não congela: aliada age, inimigo revida", async () => {
    const s = dyingSession();
    const summary = await runRulesStage(s, noop);
    expect(summary).toContain("Recovery check");
    // Com dying 1 nunca morre (máx +2 → dying 3): a aliada agiu sempre.
    expect(summary).toContain("Sela Strike vs Foe");
    // Revide aconteceu — e enquanto o jogador segue CAÍDO ele não é alvo
    // (se estabilizou, volta ao rodízio como defensor: aí pode ser alvo).
    expect(summary).toMatch(/vs (Sela|Hero)/);
    if (!summary.includes("STABILIZES")) {
      expect(summary).not.toContain("Strike vs Hero");
    }
  });

  it("ao ESTABILIZAR, o combatente do jogador revive junto com o estado", async () => {
    // Roda até estabilizar (RNG do recovery check). AC 100: o revide do turno
    // não re-derruba o recém-acordado — isola o invariante da ressurreição.
    for (let i = 0; i < 60; i++) {
      const s = dyingSession(100);
      const summary = await runRulesStage(s, noop);
      if (!summary.includes("STABILIZES")) continue;
      const you = s.state.combat!.combatants.find((c) => c.kind === "player")!;
      expect(you.defeated).toBe(false);
      expect(you.currentHp).toBe(1);
      expect(s.state.currentHp).toBe(1);
      return;
    }
    throw new Error("60 tentativas sem estabilizar — estatisticamente impossível");
  });

  it("SOLO (sem aliados) o ramo de dying continua como era: só o recovery check", async () => {
    const player = mk({
      name: "Hero",
      kind: "player",
      currentHp: 0,
      defeated: true,
      conditions: ["dying 1", "unconscious"],
    });
    const foe = mk({ name: "Foe", kind: "enemy" });
    const s = sessionWith(player, foe);
    s.state.currentHp = 0;
    s.state.conditions = ["dying 1", "unconscious"];
    s.state.combat!.active = false; // solo: a queda já fechou o combate
    const summary = await runRulesStage(s, noop);
    expect(summary).toContain("Recovery check");
    expect(summary).not.toContain("Strike");
  });
});

// Strike de statblock real do aliado (via sourceName) — lê o dataset gerado.
describe.skipIf(!hasGenerated)("resolveAllyTurns com bestiary (requer generated/)", () => {
  it("aliada com sourceName usa o ataque real e MAP agile", () => {
    const player = mk({ name: "Hero", kind: "player", initiative: 20 });
    const rat = mk({
      name: "Ratty",
      kind: "ally",
      initiative: 15,
      level: -1,
      sourceName: "Giant Rat",
    });
    const foe = mk({ name: "Foe", kind: "enemy", ac: 1, maxHp: 200, currentHp: 200, initiative: 5 });
    const s = sessionWith(player, rat, foe);
    const lines = resolveAllyTurns(s, noop);
    expect(lines[0]).toContain("Ratty Jaws Strike vs Foe");
    expect(lines[1]).toContain("[MAP -4 agile]");
  });
});
