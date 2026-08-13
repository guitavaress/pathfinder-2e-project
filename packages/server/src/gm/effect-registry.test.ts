/**
 * O registro de efeitos LIGADO ao turno (Fase 2.6 / T6.1).
 *
 * `active-effects.test.ts` prova as funções puras; este prova que elas estão
 * plugadas nos limites de tempo reais da engine. A distinção importa: a Fase 2.5
 * nasceu de descobrir infraestrutura testada e DESLIGADA (ADR-008), e um efeito
 * que nunca expira é um bônus permanente inventado.
 */
import { describe, expect, it } from "vitest";
import type { ActiveEffect, Character, Combatant, GameState } from "@pf2e/shared";
import { executeTool, resolveEnemyTurns, runRulesStage } from "./agent.js";
import { buildCombat } from "./combat.js";
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

function effect(over: Partial<ActiveEffect> = {}): ActiveEffect {
  return {
    slug: "heroism",
    name: "Spell Effect: Heroism",
    source: "Heroism",
    unit: "rounds",
    value: 1,
    expiresOnRound: null,
    ...over,
  };
}

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

function sessionWith(effects: ActiveEffect[], ...combatants: Combatant[]): Session {
  const player = combatants.find((c) => c.kind === "player");
  const state: GameState = {
    sessionId: "t",
    currentHp: player?.currentHp ?? 40,
    conditions: [],
    flags: {},
    combat: combatants.length ? buildCombat(combatants) : null,
    effects,
  };
  return {
    id: "t",
    state,
    character: mkCharacter({ name: player?.name ?? "Jão", maxHp: player?.maxHp ?? 65 }),
    messages: [],
  } as unknown as Session;
}

describe("o efeito ativo mexe no NÚMERO, pelo caminho real (T6.2)", () => {
  /** Uma sessão em combate com a ficha dada e um inimigo que erra sempre. */
  function stanceSession(feats: string[]): Session {
    const player = mk({ name: "Jão", kind: "player", ac: 20, initiative: 20 });
    const foe = mk({ name: "Foe", kind: "enemy", initiative: 5 });
    const s = sessionWith([], player, foe);
    s.character = mkCharacter({ feats, ac: 20 });
    return s;
  }

  /**
   * A CA usada na rolagem vive no LABEL do check, não na linha player-safe.
   * Uma diferença de 1 ponto não é observável pelo resultado (só viraria um
   * único valor de d20), então o label é o único jeito honesto de afirmar que a
   * engine usou o número certo — sem inventar um proxy estatístico.
   */
  function acLabels(s: Session): string[] {
    const labels: string[] = [];
    resolveEnemyTurns(s, (e) => {
      if (e.type === "check") labels.push(e.result.label);
    });
    return labels;
  }

  it("entrar em Crane Stance dá +1 de CA que a ENGINE usa no ataque inimigo", async () => {
    // Crane Stance: `Stance: Crane Stance` carrega FlatModifier ac circumstance
    // +1, sem predicado. A CA da ficha é final, mas um efeito não pode estar
    // embutido nela — é a exceção ao não-duplo-cômputo, provada de ponta a ponta.
    const s = stanceSession(["Crane Stance"]);
    await executeTool(s, "spend_actions", { actions: 1, reason: "Jão enters Crane Stance" }, noop);
    expect(s.state.effects?.map((e) => e.slug)).toEqual(["crane-stance"]);
    expect(acLabels(s)[0]).toContain("vs Jão (AC 21");
  });

  it("sem a postura, a MESMA cena usa a CA da ficha", async () => {
    const s = stanceSession([]);
    await executeTool(s, "spend_actions", { actions: 1, reason: "Jão enters Crane Stance" }, noop);
    expect(s.state.effects ?? []).toEqual([]);
    expect(acLabels(s)[0]).toContain("vs Jão (AC 20");
  });

  it("a resistência do efeito entra no combatente do jogador", async () => {
    const s = stanceSession(["Crane Stance"]);
    s.state.effects = [
      {
        slug: "cloak-in-embers",
        name: "Effect: Cloak in Embers",
        source: "teste",
        unit: "encounter",
        value: -1,
        expiresOnRound: null,
      },
    ];
    // A concessão dispara o sync das defesas tipadas do combatente.
    await executeTool(s, "spend_actions", { actions: 1, reason: "Jão enters Crane Stance" }, noop);
    const you = s.state.combat!.combatants.find((x) => x.kind === "player")!;
    expect(you.resistances).toEqual([{ type: "fire", value: 10 }]);
  });
});

describe("expiração no descanso noturno", () => {
  it("o que tem prazo acaba na noite; o sem prazo atravessa", async () => {
    const s = sessionWith([
      effect({ slug: "hero", unit: "minutes", value: 10 }),
      effect({ slug: "perm", unit: "unlimited", value: -1 }),
    ]);
    s.state.currentHp = 20;
    const out = await executeTool(s, "rest", { kind: "overnight" }, noop);
    expect(s.state.effects!.map((e) => e.slug)).toEqual(["perm"]);
    expect(out.summaryLine).toContain("1 effect(s) wear off overnight");
  });

  it("sem efeito nenhum, a linha do descanso não muda de forma", async () => {
    const s = sessionWith([]);
    s.state.currentHp = 20;
    const out = await executeTool(s, "rest", { kind: "overnight" }, noop);
    expect(out.summaryLine).not.toContain("wear off");
  });
});

describe("expiração dentro do combate (runRulesStage)", () => {
  /** O jogador caído resolve o turno inteiro em código — sem GPU. */
  function dyingSession(effects: ActiveEffect[], round = 1): Session {
    const player = mk({
      name: "Hero",
      kind: "player",
      currentHp: 0,
      defeated: true,
      conditions: ["dying 1", "unconscious"],
      initiative: 20,
    });
    const ally = mk({ name: "Sela", kind: "ally", ac: 100, maxHp: 200, currentHp: 200, initiative: 15 });
    const foe = mk({ name: "Foe", kind: "enemy", ac: 100, maxHp: 500, currentHp: 500, initiative: 5 });
    const s = sessionWith(effects, player, ally, foe);
    s.state.currentHp = 0;
    s.state.conditions = ["dying 1", "unconscious"];
    s.state.combat!.round = round;
    return s;
  }

  it("prazo em rodadas vencido sai no fim da rodada, e sai no resumo", async () => {
    const s = dyingSession([effect({ slug: "hero", unit: "rounds", value: 1, expiresOnRound: 1 })]);
    const summary = await runRulesStage(s, noop);
    expect(s.state.effects).toEqual([]);
    expect(summary).toContain("Effect ends: Heroism (1 round)");
  });

  it("prazo ainda em pé sobrevive à rodada", async () => {
    const s = dyingSession([effect({ slug: "hero", unit: "rounds", value: 9, expiresOnRound: 9 })]);
    await runRulesStage(s, noop);
    expect(s.state.effects!.map((e) => e.slug)).toEqual(["hero"]);
  });

  it("o efeito sem prazo não é tocado pelo tick de rodada", async () => {
    const s = dyingSession([effect({ slug: "perm", unit: "unlimited", value: -1 })]);
    await runRulesStage(s, noop);
    expect(s.state.effects!.map((e) => e.slug)).toEqual(["perm"]);
  });

  it("a luta fecha em DERROTA e o que durava o encontro acaba com ela", async () => {
    // Sem aliado e com o inimigo acertando de graça, o ramo de dying leva o
    // jogador a `dead`/derrota — e o encerramento tem de expirar os efeitos.
    const player = mk({
      name: "Hero",
      kind: "player",
      ac: 1,
      currentHp: 0,
      defeated: true,
      conditions: ["dying 3", "unconscious"],
      initiative: 20,
    });
    const foe = mk({ name: "Foe", kind: "enemy", ac: 1, maxHp: 500, currentHp: 500, initiative: 5 });
    const s = sessionWith([effect({ slug: "enc", unit: "encounter", value: -1 })], player, foe);
    s.state.currentHp = 0;
    s.state.conditions = ["dying 3", "unconscious"];
    // Roda até o recovery check falhar e a luta terminar (RNG do d20).
    for (let i = 0; i < 60; i++) {
      const t = sessionWith([effect({ slug: "enc", unit: "encounter", value: -1 })], player, foe);
      t.state.currentHp = 0;
      t.state.conditions = ["dying 3", "unconscious"];
      await runRulesStage(t, noop);
      if (t.state.combat?.active === false) {
        expect(t.state.effects).toEqual([]);
        return;
      }
    }
    throw new Error("60 tentativas sem a luta fechar — estatisticamente improvável");
  });
});
