/**
 * Reação DEFENSIVA do jogador disparada pela engine (J5).
 *
 * A lacuna que estes testes fecham: `chargeNonAction` só era alcançável por
 * tool call do modelo — durante o turno do JOGADOR. Como o revide inimigo roda
 * em código DEPOIS do estágio de regras, não havia instante em que a reação
 * pudesse disparar no gatilho certo. Nove cenários da bateria passavam com a
 * reação intacta enquanto o inimigo atacava.
 */
import { describe, expect, it } from "vitest";
import type { Character, Combatant, GameState } from "@pf2e/shared";
import { resolveEnemyTurns } from "./agent.js";
import { buildCombat } from "./combat.js";
import type { Session } from "./sessions.js";

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

function sessionWith(
  opts: { feats?: string[]; equipment?: string[]; playerAc?: number },
  ...combatants: Combatant[]
): Session {
  const player = combatants.find((c) => c.kind === "player")!;
  const combat = buildCombat(combatants);
  const state: GameState = {
    sessionId: "t",
    currentHp: player.currentHp,
    conditions: [],
    flags: {},
    combat,
  };
  const character = {
    name: player.name,
    maxHp: player.maxHp,
    feats: opts.feats ?? [],
    equipment: (opts.equipment ?? []).map((name) => ({ name, qty: 1 })),
    armor: [],
  } as unknown as Character;
  return { id: "t", state, character, messages: [] } as unknown as Session;
}

const noop = () => {};

/**
 * AC calibrada para que o ataque do benchmark nível 5 (bônus +15) acerte com
 * frequência e o +2 da reação seja decisivo numa fatia grande dos d20 — o que
 * garante que ALGUM golpe da rodada acione a reação.
 */
function fight(feats: string[], equipment: string[] = []) {
  const player = mk({ name: "Hero", kind: "player", ac: 20, maxHp: 300, currentHp: 300, initiative: 20 });
  const foe = mk({ name: "Foe", kind: "enemy", level: 5, initiative: 5 });
  const s = sessionWith({ feats, equipment }, player, foe);
  const lines = resolveEnemyTurns(s, noop);
  return { s, player, lines, text: lines.join("\n") };
}

describe("reação defensiva do jogador (engine)", () => {
  it("SEM o feat, a reação nunca é gasta (comportamento anterior preservado)", () => {
    // 40 rodadas: sem feat na ficha, nada consome a reação em nenhuma delas.
    for (let i = 0; i < 40; i++) {
      const { player, text } = fight([]);
      expect(player.reactionAvailable).toBe(true);
      expect(text).not.toContain("Reaction:");
    }
  });

  it("COM Nimble Dodge, a reação dispara e vira o resultado do golpe", () => {
    // A reação só é gasta quando MUDA o desfecho, então varremos várias
    // rodadas até achar uma em que o gatilho valeu — e conferimos o efeito.
    let fired = 0;
    for (let i = 0; i < 60; i++) {
      const { player, lines } = fight(["Nimble Dodge"]);
      const reacted = lines.find((l) => l.includes("Reaction: Nimble Dodge"));
      if (!reacted) continue;
      fired++;
      // Disparou: a reação foi consumida...
      expect(player.reactionAvailable).toBe(false);
      expect(reacted).toContain("+2 AC →");
      // ...e o golpe foi REBAIXADO. +2 de CA só pode piorar o ataque, então um
      // acerto crítico nunca sobrevive à reação — este é o invariante real.
      expect(reacted).not.toMatch(/→ CRITICAL HIT/);
    }
    expect(fired).toBeGreaterThan(0);
  });

  it("a reação é UMA por rodada, mesmo com o inimigo golpeando duas vezes", () => {
    for (let i = 0; i < 60; i++) {
      const { text } = fight(["Nimble Dodge"]);
      const disparos = (text.match(/Reaction: Nimble Dodge/g) ?? []).length;
      expect(disparos).toBeLessThanOrEqual(1);
    }
  });

  it("Reactive Shield exige escudo na ficha", () => {
    let semEscudo = 0;
    for (let i = 0; i < 40; i++) {
      if (fight(["Reactive Shield"]).text.includes("Reaction:")) semEscudo++;
    }
    expect(semEscudo).toBe(0);

    let comEscudo = 0;
    for (let i = 0; i < 60; i++) {
      if (fight(["Reactive Shield"], ["Steel Shield"]).text.includes("Reaction: Reactive Shield")) {
        comEscudo++;
      }
    }
    expect(comEscudo).toBeGreaterThan(0);
  });

  it("feat que não é reação defensiva não dispara nada", () => {
    for (let i = 0; i < 30; i++) {
      expect(fight(["Toughness", "Incredible Initiative"]).text).not.toContain("Reaction:");
    }
  });

  it("a reação nunca é gasta em golpe que já erraria por conta própria", () => {
    // AC altíssima: todo ataque erra sem ajuda. Gastar a reação ali seria
    // desperdício — a engine guarda.
    for (let i = 0; i < 30; i++) {
      const player = mk({ name: "Hero", kind: "player", ac: 100, maxHp: 100, currentHp: 100 });
      const foe = mk({ name: "Foe", kind: "enemy", level: 5 });
      const s = sessionWith({ feats: ["Nimble Dodge"] }, player, foe);
      resolveEnemyTurns(s, noop);
      expect(player.reactionAvailable).toBe(true);
    }
  });

  it("aliado NÃO ganha a reação do jogador (é feat da ficha dele)", () => {
    for (let i = 0; i < 30; i++) {
      const player = mk({ name: "Hero", kind: "player", ac: 100, initiative: 20 });
      const ally = mk({ name: "Sela", kind: "ally", ac: 20, maxHp: 300, currentHp: 300, initiative: 15 });
      const foe = mk({ name: "Foe", kind: "enemy", level: 5, initiative: 5 });
      const s = sessionWith({ feats: ["Nimble Dodge"] }, player, ally, foe);
      const text = resolveEnemyTurns(s, noop).join("\n");
      // Golpes contra a aliada não podem consumir a reação do jogador.
      if (text.includes("vs Sela")) expect(text).not.toMatch(/vs Sela[^\n]*Reaction:/);
    }
  });
});
