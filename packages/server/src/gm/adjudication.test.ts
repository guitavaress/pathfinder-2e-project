/**
 * A engine DECLARA o que não executa — ao narrador e ao jogador.
 *
 * Medido em 2026-08-15: 61% das entradas de uma ficha típica caem no balde
 * CEGO (nem aplica, nem avisa). Antes disto, gastar ação com Toughness e com
 * uma habilidade de fato mecanizada produzia a MESMA linha de resumo, e o
 * jogador não tinha como saber qual foi enforced pela engine e qual foi apenas
 * narrada por cima. Declarar não fecha a lacuna — torna-a visível, que é a
 * doutrina 4 ("estado nunca mente") aplicada ao que a engine NÃO faz.
 *
 * A metade mais importante daqui é a negativa: declarar o que FUNCIONA seria
 * ruído, e ruído acaba desligado.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Character, Combatant } from "@pf2e/shared";
import { executeTool, type StreamEvent } from "./agent.js";
import { buildCombat } from "./combat.js";
import { adjudicationFor } from "../rules/coverage.js";
import { makeCorpus } from "../rules/corpus.js";
import type { Session } from "./sessions.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));

function mkSession(feats: string[]): Session {
  const player: Combatant = {
    id: "hero",
    name: "Hero",
    kind: "player",
    initiative: 20,
    ac: 20,
    maxHp: 50,
    currentHp: 50,
    conditions: [],
    actionsRemaining: 3,
    reactionAvailable: true,
    mapProgress: 0,
    level: 5,
    traits: [],
    defeated: false,
  };
  const foe: Combatant = { ...player, id: "foe", name: "Giant Rat", kind: "enemy", initiative: 3 };
  return {
    id: "t",
    character: {
      name: "Hero",
      level: 5,
      maxHp: 50,
      ac: 20,
      perception: 12,
      saves: { fortitude: 10, reflex: 12, will: 9 },
      abilityModifiers: { str: 4, dex: 2, con: 2, int: 0, wis: 1, cha: 0 },
      weaponProficiencies: { simple: 2, martial: 2 },
      weapons: [{ name: "Longsword", attack: 13, die: "d8", damageBonus: 4, damageType: "S" }],
      armor: [],
      feats,
      classFeatures: [],
      equipment: [],
      skills: {},
      lores: [],
      spellcasting: [],
    } as unknown as Character,
    state: {
      sessionId: "t",
      currentHp: 50,
      conditions: [],
      flags: {},
      combat: buildCombat([player, foe]),
    },
  } as unknown as Session;
}

describe.skipIf(!hasGenerated)("adjudicationFor (requer generated/)", () => {
  it("aponta o feat de prosa pura citado na ação", () => {
    // `Battle Medicine` é ação de perícia sem mecânica legível: a engine cobra
    // o custo e nada aplica o efeito. (`Toughness`, o exemplo óbvio, NÃO serve:
    // tem FlatModifier com leitor e é mecanizado de verdade — a auditoria o
    // classifica certo, foi o primeiro rascunho deste teste que errou.)
    const s = mkSession(["Battle Medicine"]);
    const adj = adjudicationFor(s.character, "uso Battle Medicine no aliado", ["Battle Medicine"]);
    expect(adj?.name).toBe("Battle Medicine");
    expect(adj?.reason.length).toBeGreaterThan(10);
  });

  it("aponta também o feat cuja mecânica nenhum leitor abre", () => {
    // `Assurance` traz ChoiceSet + SubstituteRoll + AdjustModifier — três das
    // 34 keys sem leitor. O dado tem a regra; a engine não a lê.
    const s = mkSession(["Assurance"]);
    const adj = adjudicationFor(s.character, "uso Assurance em Athletics", ["Assurance"]);
    expect(adj?.name).toBe("Assurance");
    expect(adj?.reason).toContain("nenhum leitor abre");
  });

  it("NÃO declara Toughness — ele é mecanizado de verdade", () => {
    const s = mkSession(["Toughness"]);
    expect(adjudicationFor(s.character, "conto com Toughness", ["Toughness"])).toBeNull();
  });

  it("NÃO declara o que a engine executa (declarar o que funciona é ruído)", () => {
    const s = mkSession(["Sneak Attack"]);
    expect(adjudicationFor(s.character, "ataco furtivo com Sneak Attack", ["Sneak Attack"])).toBeNull();
  });

  it("não dispara quando nada da ficha é citado", () => {
    const s = mkSession(["Toughness"]);
    expect(adjudicationFor(s.character, "eu corro para a porta", ["Toughness"])).toBeNull();
  });

  it("ignora nomes curtos (prosa livre casaria demais)", () => {
    const s = mkSession(["Cast"]);
    expect(adjudicationFor(s.character, "eu cast alguma coisa", ["Cast"])).toBeNull();
  });
});

describe.skipIf(!hasGenerated)("spend_actions declara ao narrador e ao jogador", () => {
  it("feat inerte: emite evento ao jogador E linha numerada ao narrador", async () => {
    const s = mkSession(["Battle Medicine"]);
    const events: StreamEvent[] = [];
    const out = await executeTool(
      s,
      "spend_actions",
      { actions: 1, reason: "uso Battle Medicine no ferido" },
      (e) => events.push(e),
    );

    // Ao JOGADOR: evento próprio, pelo mesmo canal do `check`.
    const declared = events.filter((e) => e.type === "adjudicated");
    expect(declared).toHaveLength(1);
    expect(declared[0]).toMatchObject({ adjudicated: { name: "Battle Medicine" } });

    // Ao NARRADOR: linha no resumo mecânico, com a instrução de não inventar.
    expect(out.summaryLine).toContain("Battle Medicine");
    expect(out.summaryLine).toContain("NÃO automatizado");
    expect(out.summaryLine).toContain("sem inventar número");
  });

  it("a ação ainda é COBRADA — declarar não é desfazer", async () => {
    const s = mkSession(["Battle Medicine"]);
    const you = s.state.combat!.combatants.find((c) => c.kind === "player")!;
    await executeTool(s, "spend_actions", { actions: 2, reason: "uso Battle Medicine" }, () => {});
    expect(you.actionsRemaining).toBe(1);
  });

  it("atividade comum (nada da ficha citado) não emite declaração", async () => {
    const s = mkSession(["Battle Medicine"]);
    const events: StreamEvent[] = [];
    const out = await executeTool(
      s,
      "spend_actions",
      { actions: 1, reason: "empurro a porta" },
      (e) => events.push(e),
    );
    expect(events.filter((e) => e.type === "adjudicated")).toHaveLength(0);
    expect(out.summaryLine).not.toContain("NÃO automatizado");
  });

  it("nenhuma ficha do corpus faz a declaração explodir", async () => {
    // Fichas com 20 feats sorteados do dataset: se `adjudicationFor` tiver um
    // caminho ruim (nome com regex especial, doc ausente), é aqui que aparece.
    for (const c of makeCorpus(1234, 15)) {
      const s = mkSession([]);
      s.character = c;
      const reason = `uso ${c.feats[0] ?? "nada"} agora`;
      await expect(
        executeTool(s, "spend_actions", { actions: 1, reason }, () => {}),
      ).resolves.toBeDefined();
    }
  });
});
