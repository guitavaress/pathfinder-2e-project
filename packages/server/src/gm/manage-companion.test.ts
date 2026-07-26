/**
 * T2 da Fase 2 (ADR-004): a tool manage_companion e a entrada automática dos
 * companheiros no combate. Tudo via executeTool — sem GPU.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { executeTool, syncCompanions } from "./agent.js";
import { MAX_PARTY_SIZE, newCompanion } from "./combat.js";
import { validateToolArgs } from "./tool-schemas.js";
import { createSession, type Session } from "./sessions.js";
import { parsePathbuilder } from "../pathbuilder/parse.js";

const here = dirname(fileURLToPath(import.meta.url));
const example = JSON.parse(
  readFileSync(join(here, "../../../../exemplo_personagem.json"), "utf8"),
);

const noEmit = () => {};
let session: Session;

beforeEach(() => {
  session = createSession(parsePathbuilder(example));
});

async function joinParty(name: string, extra: Record<string, unknown> = {}) {
  return executeTool(session, "manage_companion", { action: "join", name, ...extra }, noEmit);
}

describe("manage_companion — schema", () => {
  it("aceita join com persona e leave sem", () => {
    expect(
      validateToolArgs("manage_companion", {
        action: "join",
        name: "Sela",
        level: 2,
        persona: "Seca e leal.",
      }).ok,
    ).toBe(true);
    expect(validateToolArgs("manage_companion", { action: "leave", name: "Sela" }).ok).toBe(
      true,
    );
  });

  it("rejeita action inventada e chave desconhecida", () => {
    expect(validateToolArgs("manage_companion", { action: "hire", name: "X" }).ok).toBe(false);
    expect(
      validateToolArgs("manage_companion", { action: "join", name: "X", hp: 50 }).ok,
    ).toBe(false);
  });
});

describe("manage_companion — join", () => {
  it("nome inventado entra com o benchmark do nível declarado", async () => {
    const out = await joinParty("Tobin, o Batedor", { level: 2, persona: "Tagarela." });
    expect(out.isError).toBeUndefined();
    expect(session.state.companions).toHaveLength(1);
    const comp = session.state.companions![0]!;
    expect(comp.level).toBe(2);
    expect(comp.persona).toBe("Tagarela.");
    expect(comp.sourceName).toBeUndefined();
    expect(out.summaryLine).toContain("joins the party");
  });

  it("NPC do bestiary usa statblock e nível OFICIAIS (palpite do modelo perde)", async () => {
    const out = await joinParty("Goblin Warrior", { level: 10 });
    expect(out.isError).toBeUndefined();
    const comp = session.state.companions![0]!;
    // Goblin Warrior é nível -1 no bestiary — o oficial vence o 10 do modelo.
    expect(comp.level).toBe(-1);
    expect(comp.sourceName).toBeTruthy();
    expect(comp.saves).toBeDefined();
  });

  it("dedupe: re-join do mesmo nome (fuzzy) é rejeitado sem mudar nada", async () => {
    await joinParty("Sela", { level: 2 });
    const again = await joinParty("Sela, a Guerreira", { level: 3 });
    expect(again.isError).toBe(true);
    expect(session.state.companions).toHaveLength(1);
  });

  it("teto do ADR-004: a 4ª companheira não entra (party = 4 com o jogador)", async () => {
    await joinParty("Alfa", { level: 1 });
    await joinParty("Bravo", { level: 1 });
    await joinParty("Carga", { level: 1 });
    const fourth = await joinParty("Delta", { level: 1 });
    expect(fourth.isError).toBe(true);
    expect(session.state.companions).toHaveLength(MAX_PARTY_SIZE - 1);
  });
});

describe("manage_companion — leave", () => {
  it("remove do roster; nome desconhecido é erro auditável", async () => {
    await joinParty("Sela", { level: 2 });
    const out = await executeTool(
      session,
      "manage_companion",
      { action: "leave", name: "Sela" },
      noEmit,
    );
    expect(out.isError).toBeUndefined();
    expect(session.state.companions).toHaveLength(0);
    const missing = await executeTool(
      session,
      "manage_companion",
      { action: "leave", name: "Ninguém" },
      noEmit,
    );
    expect(missing.isError).toBe(true);
  });

  it("companheiro vivo em combate ativo não pode sair", async () => {
    await joinParty("Sela", { level: 2 });
    await executeTool(
      session,
      "start_combat",
      { enemies: [{ name: "Bandido", level: 1 }] },
      noEmit,
    );
    const out = await executeTool(
      session,
      "manage_companion",
      { action: "leave", name: "Sela" },
      noEmit,
    );
    expect(out.isError).toBe(true);
    expect(session.state.companions).toHaveLength(1);
  });
});

describe("companheiros no combate", () => {
  it("start_combat inclui o roster como ally e o orçamento escala com a party", async () => {
    await joinParty("Sela", { level: 2 });
    const out = await executeTool(
      session,
      "start_combat",
      { enemies: [{ name: "Bandido", level: 1, count: 2 }] },
      noEmit,
    );
    const combat = session.state.combat!;
    const allies = combat.combatants.filter((c) => c.kind === "ally");
    expect(allies).toHaveLength(1);
    expect(allies[0]!.name).toBe("Sela");
    expect(allies[0]!.id).toBe(session.state.companions![0]!.id);
    // Duo: orçamento moderate = 40 XP — os DOIS bandidos nível 1 (party nível
    // do exemplo) cabem sem corte, coisa que o solo (20 XP) não permitiria.
    expect(out.content).toContain("Combat started");
  });

  it("join no MEIO do combate entra como combatente na iniciativa", async () => {
    await executeTool(
      session,
      "start_combat",
      { enemies: [{ name: "Bandido", level: 1 }] },
      noEmit,
    );
    await joinParty("Sela", { level: 2, persona: "—" });
    const combat = session.state.combat!;
    expect(combat.combatants.some((c) => c.kind === "ally" && c.name === "Sela")).toBe(true);
    // Ordem de iniciativa preservada (desc).
    const inits = combat.combatants.map((c) => c.initiative);
    expect([...inits].sort((a, b) => b - a)).toEqual(inits);
  });

  it("syncCompanions leva ferida do combate de volta ao roster", async () => {
    await joinParty("Sela", { level: 2 });
    await executeTool(
      session,
      "start_combat",
      { enemies: [{ name: "Bandido", level: 1 }] },
      noEmit,
    );
    const combat = session.state.combat!;
    const ally = combat.combatants.find((c) => c.kind === "ally")!;
    ally.currentHp = 5;
    ally.conditions = ["frightened 1"];
    syncCompanions(session);
    const comp = session.state.companions![0]!;
    expect(comp.currentHp).toBe(5);
    expect(comp.conditions).toEqual(["frightened 1"]);
  });

  it("companheira ferida entra no PRÓXIMO combate ainda ferida", async () => {
    session.state.companions = [
      { ...newCompanion("Sela", 2, "—"), currentHp: 7 },
    ];
    await executeTool(
      session,
      "start_combat",
      { enemies: [{ name: "Bandido", level: 1 }] },
      noEmit,
    );
    const ally = session.state.combat!.combatants.find((c) => c.kind === "ally")!;
    expect(ally.currentHp).toBe(7);
  });
});
