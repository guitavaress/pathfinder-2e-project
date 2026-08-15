/**
 * O contrato de argumentos aplicado NO DISPATCH.
 *
 * Por que este arquivo existe: `validateToolArgs` nasceu em 2026-07-25
 * exportada, testada e **nunca chamada em produção**. O laço de tool calls do
 * `runRulesStage` só roda com o llama-server no ar, então nenhum teste da suíte
 * podia flagrar o buraco — e ele durou até 2026-08-15. `dispatchToolCall` existe
 * para que o caminho validação→execução seja exercitável sem GPU.
 *
 * As duas metades daqui:
 *  - COMPORTAMENTO: entrada fora do contrato é rejeitada e NADA é aplicado;
 *  - ESTRUTURA: o laço continua passando por `dispatchToolCall`. É o que impede
 *    a regressão silenciosa de voltar a chamar `executeTool` direto.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Character, Combatant } from "@pf2e/shared";
import { dispatchToolCall, executeTool } from "./agent.js";
import { buildCombat } from "./combat.js";
import type { Session } from "./sessions.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));
const agentSource = readFileSync(join(here, "agent.ts"), "utf8");

const noop = () => {};

function mkSession(): Session {
  const character = {
    name: "Hero",
    level: 5,
    maxHp: 50,
    ac: 20,
    perception: 10,
    abilityModifiers: { str: 0, dex: 4, con: 2, int: 0, wis: 1, cha: 0 },
    weaponProficiencies: { simple: 2, martial: 2 },
    weapons: [{ name: "Dagger", attack: 13, die: "d4", damageBonus: 0, damageType: "P" }],
    armor: [],
    feats: [],
    classFeatures: [],
    equipment: [{ name: "Healing Potion (Minor)", qty: 1 }],
    skills: { athletics: { modifier: 11, proficiency: 4 } },
    lores: [],
  } as unknown as Character;
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
  const rat: Combatant = {
    ...player,
    id: "rat",
    name: "Giant Rat",
    kind: "enemy",
    ac: 15,
    maxHp: 40,
    currentHp: 40,
  };
  return {
    id: "t",
    character,
    state: {
      sessionId: "t",
      currentHp: 50,
      conditions: [],
      flags: {},
      combat: buildCombat([player, rat]),
    },
  } as unknown as Session;
}

describe("o laço de tools passa pelo contrato (estrutura)", () => {
  it("runRulesStage despacha por dispatchToolCall, não por executeTool direto", () => {
    // Regressão do buraco de 3 semanas: se alguém trocar de volta por
    // `await executeTool(session, tc.function.name, ...)` no laço, o contrato
    // volta a ser letra morta e nenhum outro teste percebe.
    expect(agentSource).toMatch(/const \{ outcome, args \} = await dispatchToolCall\(/);
    expect(agentSource).not.toMatch(/await executeTool\(\s*session,\s*tc\.function\.name/);
  });

  it("dispatchToolCall é o único ponto que chama validateToolArgs", () => {
    const calls = [...agentSource.matchAll(/validateToolArgs\(/g)].length;
    expect(calls, "validateToolArgs deve ser chamada exatamente uma vez em agent.ts").toBe(1);
  });
});

describe.skipIf(!hasGenerated)("o contrato rejeita e NADA é aplicado (comportamento)", () => {
  it("chave desconhecida é rejeitada (strictObject), sem tocar no estado", async () => {
    const s = mkSession();
    const hpBefore = s.state.currentHp;
    const { outcome } = await dispatchToolCall(
      s,
      "roll_check",
      { skill: "athletics", dc: 15, reason: "climb", bogusKey: 1 },
      noop,
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("REJECTED");
    expect(s.state.currentHp).toBe(hpBefore);
  });

  it("DC abaixo do piso morre no SCHEMA, antes de chegar à engine", async () => {
    // A engine também rejeitaria (isValidDc, dc >= 5), então checar só
    // `isError` não provaria nada: passaria com o contrato desligado. O marcador
    // "REJECTED —" só sai de `explain()` em tool-schemas.ts.
    const s = mkSession();
    const { outcome } = await dispatchToolCall(
      s,
      "roll_check",
      { skill: "athletics", dc: 1, reason: "trivial" },
      noop,
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("REJECTED —");
    expect(outcome.summaryLine).toBeUndefined();
  });

  it("enum fora do domínio é rejeitado (rest.kind)", async () => {
    const s = mkSession();
    const { outcome } = await dispatchToolCall(s, "rest", { kind: "power nap" }, noop);
    expect(outcome.isError).toBe(true);
  });

  it("tool inexistente é rejeitada com a lista das válidas", async () => {
    const s = mkSession();
    const { outcome } = await dispatchToolCall(s, "roll_damage", { amount: 5 }, noop);
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("Unknown tool");
  });

  it("item que não está na ficha segue rejeitado pela ENGINE, não pelo schema", async () => {
    // A fronteira do ADR-006: schema cuida do formato, engine cuida do sentido.
    // Argumento bem formado passa o contrato e morre na validação semântica.
    const s = mkSession();
    const { outcome } = await dispatchToolCall(
      s,
      "use_item",
      { item: "Vorpal Sword", reason: "swing it" },
      noop,
    );
    expect(outcome.isError).toBe(true);
    expect(outcome.content).not.toContain("REJECTED —");
  });

  it("PROVA do delta: o caminho sem contrato ACEITA o que o contrato rejeita", async () => {
    // Este é o teste que mede a mudança, não só o estado atual. `executeTool`
    // é o dispatch cru — o que o laço chamava até 2026-08-15. Ele engole a
    // chave desconhecida e rola assim mesmo; `dispatchToolCall` rejeita. Se um
    // dia os dois se comportarem igual, ou a validação saiu do lugar, ou o
    // contrato deixou de ter dentes.
    const s = mkSession();
    const cru = await executeTool(
      s,
      "roll_check",
      { skill: "athletics", dc: 15, reason: "climb", bogusKey: 1 },
      noop,
    );
    expect(cru.isError, "executeTool cru não valida chave desconhecida").toBeUndefined();

    const { outcome: comContrato } = await dispatchToolCall(
      s,
      "roll_check",
      { skill: "athletics", dc: 15, reason: "climb", bogusKey: 1 },
      noop,
    );
    expect(comContrato.isError).toBe(true);
  });

  it("argumento VÁLIDO continua passando (a rede não apertou demais)", async () => {
    const s = mkSession();
    const { outcome } = await dispatchToolCall(
      s,
      "roll_check",
      { skill: "athletics", dc: 15, reason: "climb the wall" },
      noop,
    );
    expect(outcome.isError).toBeUndefined();
    expect(outcome.summaryLine).toBeDefined();
  });
});
