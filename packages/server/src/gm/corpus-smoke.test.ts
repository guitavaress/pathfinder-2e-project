/**
 * A engine roda com ficha ARBITRÁRIA — não só com as três feitas à mão.
 *
 * Esta é a resposta direta a "cada personagem novo revela bugs": até agora
 * nenhum teste jamais pôs uma ficha que ninguém escolheu a dedo dentro do
 * combate. As fichas do corpus são montadas do dataset real (classes, feats,
 * magias e armas de verdade), passam pelo MESMO `CharacterSchema` de um import,
 * e cobrem o que as fixtures nunca tocaram: conjuradores, nível alto, fichas
 * com 20 feats.
 *
 * O que se afirma aqui é deliberadamente sobre INVARIANTES, não sobre valores:
 * um corpus gerado não tem número esperado. "A MAP penaliza a segunda Strike"
 * vale para qualquer ficha; "o modificador é 15" só vale para a do autor — e
 * foi exatamente assim que a suíte virou refém de um Goblin Rogue 5.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Character, Combatant } from "@pf2e/shared";
import { executeTool } from "./agent.js";
import { buildCombat } from "./combat.js";
import { makeCorpus } from "../rules/corpus.js";
import type { Session } from "./sessions.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));
const noop = () => {};

function sessionFor(c: Character): Session {
  const player: Combatant = {
    id: "hero",
    name: c.name,
    kind: "player",
    initiative: 20,
    ac: c.ac,
    maxHp: c.maxHp,
    currentHp: c.maxHp,
    conditions: [],
    actionsRemaining: 3,
    reactionAvailable: true,
    mapProgress: 0,
    level: c.level,
    traits: [],
    defeated: false,
  };
  const foe: Combatant = {
    ...player,
    id: "foe",
    name: "Training Dummy",
    kind: "enemy",
    initiative: 1,
    ac: 18,
    maxHp: 500,
    currentHp: 500,
  };
  return {
    id: "t",
    character: c,
    state: {
      sessionId: "t",
      currentHp: c.maxHp,
      conditions: [],
      flags: {},
      combat: buildCombat([player, foe]),
    },
  } as unknown as Session;
}

describe.skipIf(!hasGenerated)("a engine aguenta ficha gerada (requer generated/)", () => {
  const corpus = makeCorpus(1234, 25);

  it("Strike com a arma da ficha resolve em TODAS as fichas do corpus", async () => {
    for (const c of corpus) {
      const s = sessionFor(c);
      const weapon = c.weapons[0]!.name;
      const out = await executeTool(
        s,
        "roll_check",
        { skill: weapon, target: "Training Dummy", reason: `${c.name} ataca`, dc: 18 },
        noop,
      );
      expect(out.isError, `${c.name} (${c.className} ${c.level}) com "${weapon}"`).toBeUndefined();
      expect(out.summaryLine).toBeDefined();
    }
  });

  it("a MAP penaliza a segunda Strike, seja qual for a ficha", async () => {
    // Invariante, não valor: vale para qualquer personagem.
    for (const c of corpus.slice(0, 8)) {
      const s = sessionFor(c);
      const you = s.state.combat!.combatants.find((x) => x.kind === "player")!;
      const weapon = c.weapons[0]!.name;
      const args = { skill: weapon, target: "Training Dummy", reason: "ataca", dc: 18 };
      await executeTool(s, "roll_check", args, noop);
      const mapAfterFirst = you.mapProgress;
      await executeTool(s, "roll_check", args, noop);
      expect(mapAfterFirst).toBe(1);
      expect(you.mapProgress).toBe(2);
    }
  });

  it("conjurador do corpus lança sua própria magia sem explodir", async () => {
    const casters = corpus.filter((c) => (c.spellcasting[0]?.spells.length ?? 0) > 0);
    expect(casters.length, "o corpus precisa ter conjuradores").toBeGreaterThan(0);
    for (const c of casters.slice(0, 10)) {
      const s = sessionFor(c);
      const spell = c.spellcasting[0]!.spells[0]!;
      const out = await executeTool(
        s,
        "cast_spell",
        { spell, target: "Training Dummy" },
        noop,
      );
      // Pode legitimamente REJEITAR (sem slot do rank, magia fora do
      // spellsByRank). O que não pode é explodir nem resolver em silêncio.
      expect(typeof out.content, `${c.name} conjurando ${spell}`).toBe("string");
      expect(out.content.length).toBeGreaterThan(0);
    }
  });

  it("magia que a ficha NÃO tem é rejeitada em qualquer ficha", async () => {
    for (const c of corpus.slice(0, 10)) {
      const s = sessionFor(c);
      const out = await executeTool(
        s,
        "cast_spell",
        { spell: "Meteor Swarm Supreme", target: "Training Dummy" },
        noop,
      );
      expect(out.isError, `${c.name} conjurou magia inexistente`).toBe(true);
    }
  });

  it("dano nunca sai negativo nem NaN, em nenhuma ficha", async () => {
    for (const c of corpus) {
      const s = sessionFor(c);
      const foe = s.state.combat!.combatants.find((x) => x.kind === "enemy")!;
      const before = foe.currentHp;
      await executeTool(
        s,
        "roll_check",
        { skill: c.weapons[0]!.name, target: "Training Dummy", reason: "ataca", dc: 5 },
        noop,
      );
      expect(Number.isFinite(foe.currentHp), `${c.name}: HP virou NaN`).toBe(true);
      expect(foe.currentHp).toBeLessThanOrEqual(before);
      expect(foe.currentHp).toBeGreaterThanOrEqual(0);
    }
  });
});
