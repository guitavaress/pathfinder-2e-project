import { describe, expect, it } from "vitest";
import type { Combatant, GameState } from "@pf2e/shared";
import { resolveEnemyTurns } from "./agent.js";
import { buildCombat } from "./combat.js";
import type { Session } from "./sessions.js";

/** Minimal combatant (deterministic — no RNG). */
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

/** A session whose only relevant field is state.combat + currentHp. */
function sessionWith(player: Combatant, ...enemies: Combatant[]): Session {
  const combat = buildCombat([player, ...enemies]);
  const state: GameState = {
    sessionId: "t",
    currentHp: player.currentHp,
    conditions: [],
    flags: {},
    combat,
  };
  return { id: "t", state } as unknown as Session;
}

const noop = () => {};

describe("resolveEnemyTurns", () => {
  it("cada inimigo vivo faz 2 Strikes contra o jogador", () => {
    // AC 1 força acerto sempre → dá pra contar as linhas com precisão.
    const player = mk({ name: "Hero", kind: "player", ac: 1, maxHp: 200, currentHp: 200 });
    const session = sessionWith(player, mk({ name: "Foe", kind: "enemy" }));
    const lines = resolveEnemyTurns(session, noop);
    // 2 Strikes de 1 inimigo (jogador não cai com 200 HP).
    expect(lines.filter((l) => l.includes("Strike vs Hero")).length).toBe(2);
    expect(session.state.currentHp).toBeLessThan(200);
  });

  it("não causa dano quando o jogador tem AC altíssima (todos erram)", () => {
    const player = mk({ name: "Hero", kind: "player", ac: 100, maxHp: 50, currentHp: 50 });
    const session = sessionWith(player, mk({ name: "Foe", kind: "enemy" }));
    const lines = resolveEnemyTurns(session, noop);
    expect(session.state.currentHp).toBe(50);
    expect(lines.every((l) => !l.includes("HP"))).toBe(true); // nenhum "X→Y HP"
    expect(session.state.combat!.active).toBe(true);
  });

  it("encerra o combate em DEFEAT quando o jogador cai", () => {
    const player = mk({ name: "Hero", kind: "player", ac: 1, maxHp: 3, currentHp: 3 });
    const session = sessionWith(player, mk({ name: "Foe", kind: "enemy", level: 5 }));
    const lines = resolveEnemyTurns(session, noop);
    expect(session.state.currentHp).toBe(0);
    expect(session.state.combat!.active).toBe(false);
    expect(lines.some((l) => l.includes("DEFEAT"))).toBe(true);
  });

  it("ignora inimigos derrotados", () => {
    const player = mk({ name: "Hero", kind: "player", ac: 1, maxHp: 200, currentHp: 200 });
    const session = sessionWith(
      player,
      mk({ name: "Dead", kind: "enemy", defeated: true }),
      mk({ name: "Live", kind: "enemy" }),
    );
    const lines = resolveEnemyTurns(session, noop);
    expect(lines.some((l) => l.includes("Dead Strike"))).toBe(false);
    expect(lines.filter((l) => l.includes("Live Strike")).length).toBe(2);
  });

  it("iniciativa estrita: inimigos mais lentos agem antes; mais rápidos por último", () => {
    const player = mk({ name: "Hero", kind: "player", ac: 100, initiative: 15 });
    const session = sessionWith(
      player,
      mk({ name: "Fast", kind: "enemy", initiative: 25 }), // mais rápido que o jogador
      mk({ name: "Slow", kind: "enemy", initiative: 5 }), // mais lento
    );
    const lines = resolveEnemyTurns(session, noop);
    const firstSlow = lines.findIndex((l) => l.includes("Slow Strike"));
    const firstFast = lines.findIndex((l) => l.includes("Fast Strike"));
    // O lento (que fecha esta rodada) aparece ANTES do rápido (que abre a próxima).
    expect(firstSlow).toBeGreaterThanOrEqual(0);
    expect(firstFast).toBeGreaterThan(firstSlow);
  });

  it("avança o round ao completar a rodada, mas não em vitória/derrota", () => {
    const alive = sessionWith(
      mk({ name: "Hero", kind: "player", ac: 100, maxHp: 50, currentHp: 50 }),
      mk({ name: "Foe", kind: "enemy" }),
    );
    expect(alive.state.combat!.round).toBe(1);
    resolveEnemyTurns(alive, noop);
    expect(alive.state.combat!.round).toBe(2); // rodada fechada → +1

    const dead = sessionWith(
      mk({ name: "Hero", kind: "player", ac: 1, maxHp: 3, currentHp: 3 }),
      mk({ name: "Foe", kind: "enemy", level: 5 }),
    );
    resolveEnemyTurns(dead, noop);
    expect(dead.state.combat!.round).toBe(1); // derrota → não avança
  });
});
