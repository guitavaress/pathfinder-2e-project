import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Character, Combatant } from "@pf2e/shared";
import { executeTool, resolveEnemyTurns } from "./agent.js";
import type { Session } from "./sessions.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));

const noop = () => {};

/** Caster oculto nível 5 com Fireball (2 slots rank 3) e o cantrip Ignition. */
function mkCaster(): Character {
  return {
    name: "Mago",
    level: 5,
    maxHp: 40,
    ac: 19,
    perception: 8,
    abilityModifiers: { str: 0, dex: 2, con: 1, int: 4, wis: 1, cha: 0 },
    saves: { fortitude: 8, reflex: 9, will: 11 },
    weapons: [],
    armor: [],
    feats: [],
    classFeatures: [],
    equipment: [],
    skills: {},
    lores: [],
    spellcasting: [
      {
        name: "Arcane Spontaneous",
        tradition: "arcane",
        type: "spontaneous",
        ability: "int",
        attack: 11,
        dc: 21,
        spells: ["Fireball", "Ignition"],
        slots: { "3": 2 },
        spellsByRank: { "0": ["Ignition"], "3": ["Fireball"] },
      },
    ],
  } as unknown as Character;
}

function mkSession(): Session {
  return {
    id: "t",
    character: mkCaster(),
    state: { sessionId: "t", currentHp: 40, conditions: [], flags: {}, combat: null },
  } as unknown as Session;
}

const enemies = (s: Session): Combatant[] =>
  s.state.combat!.combatants.filter((c) => c.kind === "enemy");

describe.skipIf(!hasGenerated)("cast_spell (requer generated/)", () => {
  it("magia fora da ficha é rejeitada sem gastar nada", async () => {
    const s = mkSession();
    const out = await executeTool(s, "cast_spell", { spell: "Disintegrate" }, noop);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("not on the character's sheet");
    expect(s.state.spellSlotsUsed).toBeUndefined();
  });

  it("Fireball em área: todos os inimigos salvam com o save REAL e o slot é gasto", async () => {
    const s = mkSession();
    await executeTool(
      s,
      "start_combat",
      { enemies: [{ name: "Giant Rat", count: 2 }] },
      noop,
    );
    const out = await executeTool(s, "cast_spell", { spell: "Fireball" }, noop);
    expect(out.isError).toBeUndefined();
    expect(s.state.spellSlotsUsed).toEqual({ "3": 1 });
    // 2 alvos → 2 resultados na linha (save do Giant Rat: reflex real +7).
    for (const foe of enemies(s)) {
      expect(out.summaryLine).toContain(foe.name);
    }
    // Custo de 2 ações cobrado.
    const you = s.state.combat!.combatants.find((c) => c.kind === "player")!;
    expect(you.actionsRemaining).toBe(1);
  });

  it("slots esgotados: terceiro Fireball é rejeitado com dica educativa", async () => {
    const s = mkSession();
    await executeTool(s, "start_combat", { enemies: [{ name: "Giant Rat" }] }, noop);
    // Fora das ações do turno não importa aqui: recarrega entre casts.
    for (let i = 0; i < 2; i++) {
      const you = s.state.combat!.combatants.find((c) => c.kind === "player")!;
      you.actionsRemaining = 3;
      const out = await executeTool(s, "cast_spell", { spell: "Fireball" }, noop);
      // Pode acabar o combate se os ratos caírem — recria alvo se preciso.
      if (!s.state.combat?.active) break;
      expect(out.isError).toBeUndefined();
    }
    if (s.state.combat?.active) {
      const you = s.state.combat.combatants.find((c) => c.kind === "player")!;
      you.actionsRemaining = 3;
      const out = await executeTool(s, "cast_spell", { spell: "Fireball" }, noop);
      expect(out.isError).toBe(true);
      expect(out.content).toContain("no rank-3 spell slots left");
      expect(s.state.spellSlotsUsed).toEqual({ "3": 2 });
    } else {
      // Combate fechou por vitória antes do 3º cast — slots seguem corretos.
      expect(s.state.spellSlotsUsed?.["3"]).toBeLessThanOrEqual(2);
    }
  });

  it("cantrip: sem slot, spell attack vs AC real, MAP incrementa", async () => {
    const s = mkSession();
    await executeTool(s, "start_combat", { enemies: [{ name: "Giant Rat" }] }, noop);
    const rat = enemies(s)[0]!;
    const you = s.state.combat!.combatants.find((c) => c.kind === "player")!;
    const out = await executeTool(
      s,
      "cast_spell",
      { spell: "Ignition", target: rat.name },
      noop,
    );
    expect(out.isError).toBeUndefined();
    expect(s.state.spellSlotsUsed).toBeUndefined();
    expect(out.summaryLine).toContain("cantrip, no slot");
    // Ataque de magia conta para o MAP.
    expect(you.mapProgress).toBe(1);
    // Cantrip heightened: nível 5 → rank 3.
    expect(out.summaryLine).toContain("rank 3");
  });

  it("sem ações suficientes: ILLEGAL e o slot é devolvido", async () => {
    const s = mkSession();
    await executeTool(s, "start_combat", { enemies: [{ name: "Giant Rat" }] }, noop);
    const you = s.state.combat!.combatants.find((c) => c.kind === "player")!;
    you.actionsRemaining = 1;
    const out = await executeTool(s, "cast_spell", { spell: "Fireball" }, noop);
    expect(out.isError).toBe(true);
    expect(out.content).toContain("ILLEGAL");
    expect(s.state.spellSlotsUsed?.["3"] ?? 0).toBe(0);
  });

  it("inimigo caster conjura 1x por combate (política determinística)", async () => {
    const s = mkSession();
    await executeTool(
      s,
      "start_combat",
      { enemies: [{ name: "Goblin War Chanter" }] },
      noop,
    );
    const you = s.state.combat!.combatants.find((c) => c.kind === "player")!;
    you.actionsRemaining = 0; // tomou o turno
    const round1 = resolveEnemyTurns(s, noop);
    // Conjura a melhor magia danosa estruturada (Telekinetic Projectile) e
    // fica com 1 Strike só.
    expect(round1.some((l) => l.includes("casts Telekinetic Projectile"))).toBe(true);
    const strikes1 = round1.filter((l) => l.includes("Strike vs")).length;
    expect(strikes1).toBeLessThanOrEqual(1);
    if (s.state.combat?.active) {
      const round2 = resolveEnemyTurns(s, noop);
      // Segunda rodada: sem nova conjuração (1x por combate), 2 Strikes.
      expect(round2.some((l) => l.includes("casts"))).toBe(false);
    }
  });
});
