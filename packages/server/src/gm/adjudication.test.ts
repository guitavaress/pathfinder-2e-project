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
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Character, Combatant } from "@pf2e/shared";
import { executeTool, type StreamEvent } from "./agent.js";
import { buildCombat } from "./combat.js";
import { adjudicationFor, adjudicationForSpell } from "../rules/coverage.js";
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
      // Perícias de verdade: com `skills: {}` o `roll_check` rejeita antes de
      // rolar ("no check named medicine on the sheet") e o teste da declaração
      // no caminho de perícia media a rejeição, não a declaração.
      skills: {
        medicine: { name: "medicine", ability: "wis", rank: 2, modifier: 11 },
        athletics: { name: "athletics", ability: "str", rank: 2, modifier: 13 },
      },
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
    expect(adj?.reason).toContain("no reader opens");
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
    expect(out.summaryLine).toContain("NOT automated");
    expect(out.summaryLine).toContain("do NOT invent a number");
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
    expect(out.summaryLine).not.toContain("NOT automated");
  });

  it("roll_check: feat de perícia inerte é declarado junto da rolagem", async () => {
    // O caminho onde as ações de perícia caem, e onde o silêncio era TOTAL:
    // Demoralize e "olhar feio" produziam a mesma linha. A rolagem continua
    // acontecendo; o que passa a ser dito é que o feat não foi aplicado.
    const s = mkSession(["Battle Medicine"]);
    const events: StreamEvent[] = [];
    const out = await executeTool(
      s,
      "roll_check",
      { skill: "medicine", dc: 15, reason: "uso Battle Medicine no aliado" },
      (e) => events.push(e),
    );
    expect(events.filter((e) => e.type === "check")).toHaveLength(1);
    expect(events.filter((e) => e.type === "adjudicated")).toHaveLength(1);
    expect(out.summaryLine).toContain("NOT automated");
  });

  it("roll_check: perícia comum NÃO é declarada (rolar já é o mecanismo)", async () => {
    const s = mkSession(["Battle Medicine"]);
    const events: StreamEvent[] = [];
    await executeTool(
      s,
      "roll_check",
      { skill: "athletics", dc: 15, reason: "escalo o muro" },
      (e) => events.push(e),
    );
    expect(events.filter((e) => e.type === "adjudicated")).toHaveLength(0);
  });

  it("cast_spell: magia de utilidade é declarada ao jogador", async () => {
    // 51% das magias não têm dano/save/ataque. A string sentinela avisava o
    // narrador desde sempre; o jogador via o slot sumir e nada acontecer.
    //
    // `Create Water` e não `Prestidigitation`: esta CONCEDE efeito ativo de 1
    // dia, então tem mecânica de verdade e a engine corretamente NÃO declara —
    // o primeiro rascunho deste teste escolheu o exemplo errado (de novo).
    const s = mkSession([]);
    s.character = {
      ...s.character,
      spellcasting: [
        {
          name: "Arcane",
          tradition: "arcane",
          type: "prepared",
          ability: "int",
          attack: 12,
          dc: 22,
          spells: ["Create Water"],
          slots: { "1": 2 },
          spellsByRank: { "1": ["Create Water"] },
        },
      ],
    } as unknown as Character;
    const events: StreamEvent[] = [];
    const out = await executeTool(s, "cast_spell", { spell: "Create Water" }, (e) =>
      events.push(e),
    );
    expect(out.isError).toBeUndefined();
    expect(events.filter((e) => e.type === "adjudicated")).toHaveLength(1);
  });

  it("cast_spell: magia que CONCEDE efeito ativo não é declarada", () => {
    // A fronteira que o teste acima descobriu na marra: efeito ativo com prazo
    // do dado É mecânica, e declarar aqui seria ruído.
    expect(adjudicationForSpell("Fireball")).toBeNull();
  });

  it("cast_spell: magia com dano NÃO é declarada", async () => {
    const s = mkSession([]);
    s.character = {
      ...s.character,
      spellcasting: [
        {
          name: "Arcane",
          tradition: "arcane",
          type: "prepared",
          ability: "int",
          attack: 12,
          dc: 22,
          spells: ["Fireball"],
          slots: { "3": 2 },
          spellsByRank: { "3": ["Fireball"] },
        },
      ],
    } as unknown as Character;
    const events: StreamEvent[] = [];
    await executeTool(s, "cast_spell", { spell: "Fireball", target: "Giant Rat" }, (e) =>
      events.push(e),
    );
    expect(events.filter((e) => e.type === "adjudicated")).toHaveLength(0);
  });

  it("use_item: item sem efeito é declarado; poção de cura NÃO é", async () => {
    const s = mkSession([]);
    s.character = {
      ...s.character,
      equipment: [
        { name: "Rope", qty: 1 },
        { name: "Healing Potion (Minor)", qty: 1 },
      ],
    } as unknown as Character;

    const inertes: StreamEvent[] = [];
    await executeTool(s, "use_item", { item: "Rope", reason: "amarro" }, (e) => inertes.push(e));
    expect(inertes.filter((e) => e.type === "adjudicated")).toHaveLength(1);

    const cura: StreamEvent[] = [];
    await executeTool(s, "use_item", { item: "Healing Potion (Minor)", reason: "bebo" }, (e) =>
      cura.push(e),
    );
    expect(cura.filter((e) => e.type === "adjudicated")).toHaveLength(0);
  });

  it("os QUATRO caminhos que invocam habilidade de ficha declaram", () => {
    // Regressão do buraco que a T5 deixou: a declaração nasceu só em
    // `spend_actions` e ficou lá durante um PR inteiro. Se alguém adicionar um
    // caminho novo que invoque habilidade e esquecer de declarar, este teste
    // não pega — mas se alguém REMOVER de um dos quatro, pega.
    const source = readFileSync(join(here, "agent.ts"), "utf8");
    const calls = [...source.matchAll(/declareAdjudicated\(/g)].length;
    expect(calls, "1 definição + 4 chamadas").toBe(5);
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
