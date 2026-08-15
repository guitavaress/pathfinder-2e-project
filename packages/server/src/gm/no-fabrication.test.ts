/**
 * A engine não FABRICA mecânica quando falta dado.
 *
 * Cada teste daqui cobre um caminho que, até 2026-08-15, produzia um número
 * plausível a partir de nada — e o resumo mecânico apresentava esse número como
 * resolução legítima. É a família do bug `dc ?? 0` que a doutrina 1 nomeia:
 * ausência de dado tem de virar rejeição, nunca um default silencioso.
 *
 * Nenhum destes caminhos tinha teste. Foi por isso que sobreviveram.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Character, Combatant } from "@pf2e/shared";
import { executeTool } from "./agent.js";
import { buildCombat, findCombatant } from "./combat.js";
import type { Session } from "./sessions.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));
const noop = () => {};

function mkPlayer(): Combatant {
  return {
    id: "hero",
    name: "Hero",
    kind: "player",
    initiative: 25,
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
}

function mkSession(character: Partial<Character> = {}): Session {
  const player = mkPlayer();
  const rat: Combatant = {
    ...player,
    id: "rat",
    name: "Giant Rat",
    kind: "enemy",
    initiative: 5,
    ac: 15,
    maxHp: 40,
    currentHp: 40,
  };
  return {
    id: "t",
    character: {
      name: "Hero",
      level: 5,
      maxHp: 50,
      ac: 20,
      perception: 17,
      saves: { fortitude: 10, reflex: 12, will: 9 },
      abilityModifiers: { str: 2, dex: 4, con: 2, int: 0, wis: 1, cha: 0 },
      weaponProficiencies: { simple: 2, martial: 2 },
      weapons: [{ name: "Dagger", attack: 13, die: "d4", damageBonus: 2, damageType: "P" }],
      armor: [],
      feats: [],
      classFeatures: [],
      equipment: [],
      skills: { athletics: { modifier: 11, proficiency: 4 } },
      lores: [],
      spellcasting: [],
      ...character,
    } as unknown as Character,
    state: {
      sessionId: "t",
      currentHp: 50,
      conditions: [],
      flags: {},
      combat: buildCombat([player, rat]),
    },
  } as unknown as Session;
}

describe.skipIf(!hasGenerated)("Strike não inventa bônus de ataque", () => {
  it("arma que não está na ficha é REJEITADA, não rolada com a Percepção", async () => {
    // Antes: `weapons[0]?.attack ?? perception`. Com a ficha abaixo, um
    // "Greatsword" inexistente rolava com +13 da adaga; sem armas, rolava com
    // +17 de PERCEPÇÃO — que não é bônus de ataque de coisa nenhuma.
    const s = mkSession();
    const out = await executeTool(
      s,
      "roll_check",
      { skill: "Greatsword", target: "Giant Rat", reason: "cleave the rat", dc: 15 },
      noop,
    );
    expect(out.isError).toBe(true);
    expect(out.content).toContain("No weapon or attack named");
  });

  it("rejeição não cobra ação nem avança a MAP", async () => {
    const s = mkSession();
    const you = s.state.combat!.combatants.find((c) => c.kind === "player")!;
    const actionsBefore = you.actionsRemaining;
    const mapBefore = you.mapProgress;
    await executeTool(
      s,
      "roll_check",
      { skill: "Warhammer", target: "Giant Rat", reason: "swing", dc: 15 },
      noop,
    );
    expect(you.actionsRemaining).toBe(actionsBefore);
    expect(you.mapProgress).toBe(mapBefore);
  });

  it("personagem SEM armas não vira atacante pela Percepção", async () => {
    const s = mkSession({ weapons: [] });
    const out = await executeTool(
      s,
      "roll_check",
      { skill: "Dagger", target: "Giant Rat", reason: "stab", dc: 15 },
      noop,
    );
    expect(out.isError).toBe(true);
  });

  it("Strike GENÉRICO continua funcionando (a rede não apertou demais)", async () => {
    // `resolveModifier` aceita attack/strike/ataque/unarmed como a arma [0]; o
    // dano tem de sair da MESMA arma, senão o bônus vem de uma e o dado de
    // outra. Este teste existe porque a primeira tentativa de conserto
    // introduziu exatamente essa divergência.
    const s = mkSession();
    const out = await executeTool(
      s,
      "roll_check",
      { skill: "strike", target: "Giant Rat", reason: "attack with what I hold", dc: 15 },
      noop,
    );
    expect(out.isError).toBeUndefined();
  });
});

describe("findCombatant não devolve alvo por chave vazia", () => {
  it("tag de id obsoleta não casa o combatente de maior iniciativa", () => {
    // `"giant rat".includes("")` é true: uma tag `[id:...]` de um combate
    // anterior (ids são regerados a cada buildCombat) limpava para "" e
    // devolvia combatants[0] — o de maior iniciativa — como se nomeado.
    const combat = buildCombat([mkPlayer(), { ...mkPlayer(), id: "rat", name: "Giant Rat", kind: "enemy", initiative: 5 }]);
    expect(findCombatant(combat, "[id:deadbeef]")).toBeUndefined();
    expect(findCombatant(combat, "")).toBeUndefined();
    expect(findCombatant(combat, "   ")).toBeUndefined();
  });

  it("referência legítima continua resolvendo", () => {
    const player = mkPlayer();
    const rat = { ...mkPlayer(), id: "rat", name: "Giant Rat", kind: "enemy" as const, initiative: 5 };
    const combat = buildCombat([player, rat]);
    expect(findCombatant(combat, "Giant Rat")?.id).toBe("rat");
    expect(findCombatant(combat, "rat")?.id).toBe("rat");
    expect(findCombatant(combat, `Giant Rat [id:${rat.id}]`)?.id).toBe("rat");
  });
});

describe.skipIf(!hasGenerated)("ataque de magia não rola em +0", () => {
  it("tradição sem bônus de ataque é rejeitada e NADA é gasto", async () => {
    // `parse.ts` grava `attack: null` quando o Pathbuilder não manda o campo.
    // O `?? 0` rolava a magia em +0 e o resultado passava por legítimo.
    const s = mkSession({
      spellcasting: [
        {
          name: "Arcane Prepared",
          tradition: "arcane",
          type: "prepared",
          ability: "int",
          attack: null,
          dc: 21,
          spells: ["Ignition"],
          slots: {},
          spellsByRank: { "0": ["Ignition"] },
        },
      ],
    } as unknown as Partial<Character>);
    const out = await executeTool(
      s,
      "cast_spell",
      { spell: "Ignition", target: "Giant Rat" },
      noop,
    );
    expect(out.isError).toBe(true);
    expect(out.content).toContain("no spell attack bonus");
    expect(out.content).toContain("nothing was spent");
  });
});

describe.skipIf(!hasGenerated)("update_state não engole parâmetro desconhecido", () => {
  it("hpDelta junto de chave inválida NÃO aplica o HP", async () => {
    // A brecha era o `&& !hasEffect`: com um efeito válido junto, a chave
    // desconhecida era descartada calada. Foi assim que o off-guard do Twin
    // Feint nunca aplicou.
    const s = mkSession();
    const hpBefore = s.state.currentHp;
    const out = await executeTool(
      s,
      "update_state",
      { hpDelta: -5, updateType: "off-guard" },
      noop,
    );
    expect(out.isError).toBe(true);
    expect(s.state.currentHp).toBe(hpBefore);
  });
});
