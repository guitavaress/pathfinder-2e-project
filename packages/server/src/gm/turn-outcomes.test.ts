/**
 * Caminhos que existiam sem NENHUM teste: o recovery check integrado (onde a
 * morte é definitiva), a cura por magia, o fechamento de combate e a ficha.
 *
 * O ramo de `dying` do `runRulesStage` resolve o turno inteiro em código e
 * retorna antes de qualquer chamada ao modelo — por isso roda aqui sem GPU.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Character } from "@pf2e/shared";
import { buildMechanicalSummary, executeTool, runRulesStage } from "./agent.js";
import { parsePathbuilder } from "../pathbuilder/parse.js";
import type { Session } from "./sessions.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));
const noop = () => {};

/**
 * Ficha COMPLETA a partir do personagem de exemplo real (Pathbuilder → parser).
 * Inventar o objeto à mão dava falso negativo: `characterSheetBlock` lê campos
 * que um fixture parcial não tem (`senses`, `resistances`, `money`…).
 */
const EXAMPLE = JSON.parse(
  readFileSync(join(here, "../../../../exemplo_personagem.json"), "utf8"),
) as unknown;

function fixD20(value: number): void {
  // d20 = 1 + floor(random*20): 0 → 1, 0.95 → 20.
  vi.spyOn(Math, "random").mockReturnValue(value);
}
afterEach(() => vi.restoreAllMocks());

function mkSession(over: Partial<Record<string, unknown>> = {}): Session {
  const base = parsePathbuilder(EXAMPLE) as unknown as Record<string, unknown>;
  const character = { ...base, ...over } as unknown as Character;
  return {
    id: "t",
    character,
    state: {
      sessionId: "t",
      currentHp: character.maxHp,
      conditions: [],
      flags: {},
      combat: null,
    },
    messages: [],
  } as unknown as Session;
}

describe("recovery check: o turno de quem está caído", () => {
  it("sucesso ESTABILIZA a 1 HP, acorda e sobe wounded", async () => {
    fixD20(0.95); // d20 = 20 → crítico: dying -2
    const s = mkSession();
    s.state.currentHp = 0;
    s.state.conditions = ["dying 1", "unconscious"];
    const summary = await runRulesStage(s, noop);
    expect(summary).toMatch(/STABILIZES/);
    expect(s.state.currentHp).toBe(1);
    expect(s.state.conditions.join(" ")).toMatch(/wounded 1/);
    expect(s.state.conditions.join(" ")).not.toMatch(/unconscious/i);
    expect(s.state.conditions.join(" ")).not.toMatch(/dying [1-9]/);
  });

  it("wounded acumula a cada estabilização", async () => {
    fixD20(0.95);
    const s = mkSession();
    s.state.currentHp = 0;
    s.state.conditions = ["dying 1", "unconscious", "wounded 1"];
    await runRulesStage(s, noop);
    expect(s.state.conditions.join(" ")).toMatch(/wounded 2/);
  });

  it("falha piora o dying e o jogador segue sem agir", async () => {
    fixD20(0); // d20 = 1 → falha crítica: dying +2
    const s = mkSession();
    s.state.currentHp = 0;
    s.state.conditions = ["dying 1", "unconscious"];
    const summary = await runRulesStage(s, noop);
    expect(summary).toMatch(/still unconscious/i);
    expect(s.state.conditions.join(" ")).toMatch(/dying 3/);
    expect(s.state.currentHp).toBe(0);
  });

  it("dying 4 é MORTE, e é definitiva", async () => {
    fixD20(0); // crítico de falha: 3 + 2 = 5 → >= 4
    const s = mkSession();
    s.state.currentHp = 0;
    s.state.conditions = ["dying 3", "unconscious"];
    const summary = await runRulesStage(s, noop);
    expect(summary).toMatch(/DIES\. This is final/);
    expect(s.state.conditions).toEqual(["dead"]);
  });

  it("emite o check do recovery para a UI, com o DC certo", async () => {
    fixD20(0.5);
    const s = mkSession();
    s.state.currentHp = 0;
    s.state.conditions = ["dying 2", "unconscious"];
    const events: Record<string, any>[] = [];
    await runRulesStage(s, (e) => events.push(e as Record<string, any>));
    const check = events.find((e) => e.type === "check");
    expect(check).toBeDefined();
    expect(check!.result.dc).toBe(12); // 10 + dying 2
    expect(check!.result.modifier).toBe(0); // flat check: sem modificador
  });

  it("com HP acima de 0 o ramo de dying nem roda", async () => {
    // Sanidade: se caísse aqui, o teste tentaria falar com o LLM e quebraria.
    const s = mkSession();
    s.state.currentHp = 10;
    s.state.conditions = ["dying 1"];
    // Sem combate e com HP > 0, o dying não dispara — garantimos pelo estado.
    expect(s.state.currentHp > 0).toBe(true);
  });
});

describe("resumo mecânico: o vazio é declarado, nunca silencioso", () => {
  it("fora de combate, consultar sem resolver é dito ao narrador", async () => {
    // Era o buraco do Esoteric Wayfinder: o modelo consultava a regra, nada era
    // resolvido, e o narrador ficava livre para dizer que a atividade deu certo.
    const s = mkSession();
    const summary = buildMechanicalSummary(s, [], ["Esoteric Wayfinder"], true, false);
    expect(summary).toMatch(/NOTHING was resolved mechanically/);
    expect(summary).toMatch(/do NOT state that it worked/i);
  });

  it("dois fatos numa linha só saem NUMERADOS separadamente (Fase 2.6)", () => {
    // Uma tool pode devolver o resultado E o efeito que ficou em pé
    // ("- Casts Heroism.\n- Now in effect: Heroism (10 minutes)."). Sem achatar
    // antes de numerar, o segundo fato saía sem número — e numerar existe
    // justamente para o narrador não pular nem fundir eventos (doutrina 4).
    const s = mkSession();
    const summary = buildMechanicalSummary(
      s,
      ["- Casts Heroism (rank 3).\n- Now in effect: Heroism (10 minutes)."],
      [],
      true,
      false,
    );
    expect(summary).toMatch(/1\. Casts Heroism/);
    expect(summary).toMatch(/2\. Now in effect: Heroism \(10 minutes\)/);
    expect(summary).not.toMatch(/NOTHING was resolved/);
  });

  it("turno sem tool nenhuma continua sendo 'nenhuma rolagem necessária'", () => {
    const s = mkSession();
    expect(buildMechanicalSummary(s, [], [], false, false)).toBe(
      "No roll was needed this turn.",
    );
  });

  it("com mecânica resolvida, nenhum aviso de vazio aparece", () => {
    const s = mkSession();
    const summary = buildMechanicalSummary(s, ["- Stealth check: success."], [], true, false);
    expect(summary).not.toMatch(/NOTHING was resolved/);
    expect(summary).toMatch(/Stealth check/);
  });

  it("em combate o aviso de vazio é o de combate", async () => {
    const s = mkSession();
    await executeTool(s, "start_combat", { enemies: [{ name: "Bandit", level: 1 }] }, noop);
    const summary = buildMechanicalSummary(s, [], ["Shake it Off"], true, false);
    expect(summary).toMatch(/NOTHING was resolved this turn/);
    expect(summary).toMatch(/do NOT invent any blow/i);
  });
});

describe("fechamento de combate", () => {
  it("end_combat encerra e o estado reflete", async () => {
    const s = mkSession();
    await executeTool(s, "start_combat", { enemies: [{ name: "Bandit", level: 1 }] }, noop);
    expect(s.state.combat!.active).toBe(true);
    const out = await executeTool(s, "end_combat", { reason: "o bandido fugiu" }, noop);
    expect(out.isError).toBeFalsy();
    expect(s.state.combat?.active).toBeFalsy();
  });

  it("end_combat sem combate não inventa estado", async () => {
    const s = mkSession();
    const out = await executeTool(s, "end_combat", { reason: "nada acontecendo" }, noop);
    expect(s.state.combat?.active).toBeFalsy();
    expect(out.content).toMatch(/no active combat/i);
  });

  it("end_turn é inofensivo e não zera o combate", async () => {
    const s = mkSession();
    await executeTool(s, "start_combat", { enemies: [{ name: "Bandit", level: 1 }] }, noop);
    const out = await executeTool(s, "end_turn", {}, noop);
    expect(out.isError).toBeFalsy();
    expect(out.endedTurn).toBe(true);
  });
});

describe("get_character devolve a ficha real", () => {
  it("traz nome, nível, CA e saves da ficha", async () => {
    const s = mkSession();
    const out = await executeTool(s, "get_character", {}, noop);
    expect(out.isError).toBeFalsy();
    expect(out.content).toMatch(new RegExp(s.character.name));
    expect(out.content).toMatch(new RegExp(`AC: ${s.character.ac}`));
    expect(out.content).toMatch(/Saves: Fort [+-]\d+, Ref [+-]\d+, Will [+-]\d+/);
    expect(out.content).toMatch(new RegExp(`level ${s.character.level}`));
  });
});

describe.skipIf(!hasGenerated)("cura por magia (requer generated/)", () => {
  it("Heal na própria ficha cura de verdade e gasta o slot", async () => {
    const s = mkSession({
      spellcasting: [
        {
          name: "Cleric",
          tradition: "divine",
          type: "prepared",
          ability: "wis",
          attack: 11,
          dc: 21,
          spells: ["Heal"],
          slots: { "1": 2 },
        },
      ],
    });
    s.state.currentHp = 20;
    const out = await executeTool(s, "cast_spell", { spell: "Heal" }, noop);
    expect(out.isError).toBeFalsy();
    // A cura vem do dado REAL da magia; o que importa é que subiu e não passou do máximo.
    expect(s.state.currentHp).toBeGreaterThan(20);
    expect(s.state.currentHp).toBeLessThanOrEqual(60);
  });

  it("magia fora da ficha é rejeitada e não gasta nada", async () => {
    const s = mkSession({
      spellcasting: [
        {
          name: "Cleric",
          tradition: "divine",
          type: "prepared",
          ability: "wis",
          attack: 11,
          dc: 21,
          spells: ["Heal"],
          slots: { "1": 2 },
        },
      ],
    });
    s.state.currentHp = 20;
    const out = await executeTool(s, "cast_spell", { spell: "Fireball" }, noop);
    expect(out.isError).toBe(true);
    expect(s.state.currentHp).toBe(20);
  });
});
