import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Character, Combatant } from "@pf2e/shared";
import { executeTool } from "./agent.js";
import { beginPlayerRound } from "./combat.js";
import { costProfileOf } from "../rules/dataset.js";
import type { Session } from "./sessions.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));

const noop = () => {};

function mkSession(feats: string[]): Session {
  const character = {
    name: "Ferro",
    level: 5,
    maxHp: 60,
    ac: 22,
    perception: 12,
    abilityModifiers: { str: 4, dex: 2, con: 3, int: 0, wis: 1, cha: 0 },
    saves: { fortitude: 12, reflex: 10, will: 9 },
    weapons: [{ name: "Longsword", attack: 13, die: "d8", damageBonus: 4, damageType: "S" }],
    armor: [{ name: "Steel Shield" }],
    feats,
    classFeatures: [],
    equipment: [{ name: "Steel Shield", qty: 1 }],
    skills: { athletics: { name: "athletics", ability: "str", rank: 1, modifier: 11 } },
    lores: [],
    spellcasting: [],
  } as unknown as Character;
  return {
    id: "t",
    character,
    state: { sessionId: "t", currentHp: 60, conditions: [], flags: {}, combat: null },
  } as unknown as Session;
}

async function startFight(s: Session): Promise<void> {
  await executeTool(s, "start_combat", { enemies: [{ name: "Bandit", level: 1 }] }, noop);
  // O jogador age primeiro nos testes: 3 ações e reação disponíveis.
  beginPlayerRound(s.state.combat!);
}

const player = (s: Session): Combatant =>
  s.state.combat!.combatants.find((c) => c.kind === "player")!;

describe.skipIf(!hasGenerated)("costProfileOf (requer generated/)", () => {
  it("lê a taxonomia real do dado, não só 'action'", () => {
    expect(costProfileOf("Nimble Dodge")).toMatchObject({ kind: "reaction", cost: 0 });
    expect(costProfileOf("Reactive Shield")).toMatchObject({ kind: "reaction", cost: 0 });
    expect(costProfileOf("Sudden Charge")).toMatchObject({ kind: "action", cost: 2 });
  });

  it("desempata homônimo pela categoria pedida (caso Shake it Off)", () => {
    // `actions.json` tem uma REAÇÃO [fortune, primal] com o mesmo nome do feat
    // de bárbaro de 1 AÇÃO, e ofuscava o feat no índice por ordem alfabética.
    expect(costProfileOf("Shake it Off", "feats")).toMatchObject({
      kind: "action",
      cost: 1,
    });
    expect(costProfileOf("Shake it Off", "actions")).toMatchObject({
      kind: "reaction",
      cost: 0,
    });
  });

  it("nome desconhecido não vira custo inventado", () => {
    expect(costProfileOf("Golpe Fictício do Vazio")).toBeNull();
  });
});

describe.skipIf(!hasGenerated)("lookup_rule mostra o custo e não esconde homônimo", () => {
  it("declara o custo de ação explicitamente", async () => {
    const s = mkSession([]);
    const out = await executeTool(s, "lookup_rule", { query: "Sudden Charge" }, noop);
    expect(out.content).toMatch(/\[2 actions\]/);
  });

  it("avisa quando outro registro divide o nome (caso Shake it Off)", async () => {
    const s = mkSession(["Shake it Off"]);
    const out = await executeTool(s, "lookup_rule", { query: "Shake it Off" }, noop);
    // O índice serve a reação de actions.json; o feat de 1 ação PRECISA aparecer.
    expect(out.content).toMatch(/another entry shares this name/i);
    expect(out.content).toMatch(/\(feats\) \[1 action\]/);
  });

  it("regra sem homônimo não ganha ruído", async () => {
    const s = mkSession([]);
    const out = await executeTool(s, "lookup_rule", { query: "Sudden Charge" }, noop);
    expect(out.content).not.toMatch(/another entry shares this name/i);
  });
});

describe.skipIf(!hasGenerated)("economia de reação do jogador (requer generated/)", () => {
  it("reação não sai das 3 ações e consome a reação", async () => {
    const s = mkSession(["Reactive Shield"]);
    await startFight(s);
    const out = await executeTool(
      s,
      "spend_actions",
      { actions: 1, reason: "Ferro uses Reactive Shield to block the blow" },
      noop,
    );
    expect(out.isError).toBeFalsy();
    // Antes disto a engine cobrava 1 das 3 ações e nunca gastava a reação.
    expect(player(s).actionsRemaining).toBe(3);
    expect(player(s).reactionAvailable).toBe(false);
    expect(out.summaryLine).toMatch(/reaction/i);
  });

  it("segunda reação na mesma rodada é ILEGAL", async () => {
    const s = mkSession(["Nimble Dodge"]);
    await startFight(s);
    await executeTool(s, "spend_actions", { actions: 1, reason: "Nimble Dodge" }, noop);
    const second = await executeTool(
      s,
      "spend_actions",
      { actions: 1, reason: "Nimble Dodge again" },
      noop,
    );
    expect(second.isError).toBe(true);
    expect(second.content).toMatch(/already used their reaction/i);
    expect(player(s).actionsRemaining).toBe(3);
  });

  it("a reação recarrega no início do turno seguinte", async () => {
    const s = mkSession(["Nimble Dodge"]);
    await startFight(s);
    await executeTool(s, "spend_actions", { actions: 1, reason: "Nimble Dodge" }, noop);
    expect(player(s).reactionAvailable).toBe(false);
    beginPlayerRound(s.state.combat!);
    expect(player(s).reactionAvailable).toBe(true);
    const again = await executeTool(
      s,
      "spend_actions",
      { actions: 1, reason: "Nimble Dodge" },
      noop,
    );
    expect(again.isError).toBeFalsy();
    expect(player(s).reactionAvailable).toBe(false);
  });

  it("reação resolvida por check também não gasta ação", async () => {
    const s = mkSession(["Nimble Dodge"]);
    await startFight(s);
    const out = await executeTool(
      s,
      "roll_check",
      { skill: "reflex", dc: 18, actions: 1, reason: "Nimble Dodge against the swing" },
      noop,
    );
    expect(out.isError).toBeFalsy();
    expect(player(s).actionsRemaining).toBe(3);
    expect(player(s).reactionAvailable).toBe(false);
  });

  it("free action não gasta ação NEM a reação", async () => {
    const s = mkSession(["Cat's Luck"]);
    await startFight(s);
    const out = await executeTool(
      s,
      "spend_actions",
      { actions: 1, reason: "Cat's Luck to reroll" },
      noop,
    );
    expect(out.isError).toBeFalsy();
    expect(player(s).actionsRemaining).toBe(3);
    expect(player(s).reactionAvailable).toBe(true);
  });

  it("feat que a ficha NÃO tem não vira reação grátis", async () => {
    // O scanner é dirigido pela ficha: citar Nimble Dodge sem tê-lo cobra ação.
    const s = mkSession([]);
    await startFight(s);
    await executeTool(s, "spend_actions", { actions: 1, reason: "Nimble Dodge" }, noop);
    expect(player(s).actionsRemaining).toBe(2);
    expect(player(s).reactionAvailable).toBe(true);
  });

  it("regressão: feat de AÇÃO segue cobrando ações", async () => {
    const s = mkSession(["Sudden Charge"]);
    await startFight(s);
    await executeTool(s, "spend_actions", { actions: 1, reason: "Sudden Charge" }, noop);
    // Custo do dado (2), não o 1 que o modelo passou.
    expect(player(s).actionsRemaining).toBe(1);
    expect(player(s).reactionAvailable).toBe(true);
  });

  it("regressão: Shake it Off cobra 1 ação (o homônimo de reação não vale)", async () => {
    const s = mkSession(["Shake it Off"]);
    await startFight(s);
    await executeTool(
      s,
      "spend_actions",
      { actions: 1, reason: "Shake it Off to shrug off the fear" },
      noop,
    );
    expect(player(s).actionsRemaining).toBe(2);
    expect(player(s).reactionAvailable).toBe(true);
  });
});
