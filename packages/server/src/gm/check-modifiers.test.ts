/**
 * A rolagem NÃO-ataque passa a receber os modificadores do dado (Fase 2.5 / T5.4).
 *
 * Duas lacunas fechadas aqui, ambas verificáveis pelo `modifier` do CheckResult
 * (determinístico — não depende do dado rolado):
 *
 * 1. Condições só penalizavam ATAQUE. `frightened` tem selector `all` no dado,
 *    ou seja, penaliza toda checagem e DC — mas `attackStatusPenalty` só era
 *    consultado em Strike, então uma perícia com o personagem apavorado saía
 *    limpa.
 * 2. Os `FlatModifier` situacionais dos feats da ficha não existiam para a
 *    engine: 712 dos 781 rule elements dessas categorias têm predicado, e
 *    nenhum era avaliado.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Character } from "@pf2e/shared";
import { executeTool } from "./agent.js";
import type { Session } from "./sessions.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));
const noop = () => {};

function mkSession(opts: { feats?: string[]; conditions?: string[] } = {}): Session {
  const character = {
    name: "Jão",
    level: 5,
    ancestry: "Human",
    heritage: null,
    background: "Hunter",
    className: "Fighter",
    maxHp: 60,
    ac: 22,
    perception: 12,
    abilityModifiers: { str: 4, dex: 2, con: 3, int: 0, wis: 1, cha: 0 },
    saves: { fortitude: 12, reflex: 10, will: 9 },
    skills: {
      athletics: { name: "athletics", ability: "str", rank: 2, modifier: 13 },
      stealth: { name: "stealth", ability: "dex", rank: 1, modifier: 9 },
    },
    lores: [],
    feats: opts.feats ?? [],
    classFeatures: [],
    weapons: [{ name: "Longsword", attack: 13, die: "d8", damageBonus: 4, damageType: "S" }],
    armor: [],
    equipment: [],
    spellcasting: [],
    resistances: [],
  } as unknown as Character;
  return {
    id: "t",
    character,
    state: {
      sessionId: "t",
      currentHp: 60,
      conditions: opts.conditions ?? [],
      flags: {},
      combat: null,
    },
  } as unknown as Session;
}

/** Roda um roll_check e devolve o CheckResult decodificado. */
async function check(
  s: Session,
  skill: string,
  reason = "tenta algo",
): Promise<Record<string, any>> {
  const out = await executeTool(s, "roll_check", { skill, dc: 20, reason }, noop);
  expect(out.isError, out.content).toBeFalsy();
  return JSON.parse(out.content) as Record<string, any>;
}

describe.skipIf(!hasGenerated)("condições fora de combate agora pesam na perícia", () => {
  it("frightened 2 penaliza uma checagem de perícia em −2", async () => {
    const clean = await check(mkSession(), "stealth");
    const scared = await check(mkSession({ conditions: ["frightened 2"] }), "stealth");
    expect(clean.modifier).toBe(9);
    expect(scared.modifier).toBe(7);
  });

  it("o porquê vai no rótulo, para a UI e para a auditoria", async () => {
    const scared = await check(mkSession({ conditions: ["frightened 1"] }), "stealth");
    expect(scared.label).toContain("-1 status (frightened)");
  });

  it("condição sem efeito sobre a rolagem não muda o número", async () => {
    // `fleeing` não tem FlatModifier no dado — e não deve inventar um.
    const fleeing = await check(mkSession({ conditions: ["fleeing"] }), "stealth");
    expect(fleeing.modifier).toBe(9);
    expect(fleeing.label).not.toContain("[");
  });

  it("um save também é penalizado (selector `all` cobre tudo)", async () => {
    const clean = await check(mkSession(), "will");
    const scared = await check(mkSession({ conditions: ["frightened 3"] }), "will");
    expect(clean.modifier).toBe(9);
    expect(scared.modifier).toBe(6);
  });
});

describe.skipIf(!hasGenerated)("feats situacionais da ficha entram na rolagem", () => {
  it("Natural Climber dá +2 em Athletics ao escalar — e só ao escalar", async () => {
    const s = mkSession({ feats: ["Natural Climber"] });
    const climbing = await check(s, "athletics", "Climb the wall");
    const other = await check(s, "athletics", "arromba a porta a ombradas");
    expect(climbing.modifier).toBe(15);
    expect(other.modifier).toBe(13);
  });

  it("sem o feat, escalar não ganha nada", async () => {
    const s = mkSession();
    expect((await check(s, "athletics", "Climb the wall")).modifier).toBe(13);
  });

  it("condição e feat convivem na mesma pilha", async () => {
    const s = mkSession({ feats: ["Natural Climber"], conditions: ["frightened 1"] });
    // +2 circunstância (feat) −1 status (frightened) sobre o 13 da ficha.
    expect((await check(s, "athletics", "Climb the wall")).modifier).toBe(14);
  });

  it("modificador incondicional do feat NÃO é somado de novo", async () => {
    // Nimble Elf dá +5 de land-speed sem predicado: o Pathbuilder já embutiu.
    // Se algum dia vazasse para uma rolagem, este número mudaria.
    const s = mkSession({ feats: ["Nimble Elf"] });
    expect((await check(s, "athletics")).modifier).toBe(13);
  });
});
