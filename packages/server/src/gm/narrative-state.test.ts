import { describe, expect, it } from "vitest";
import type { Character } from "@pf2e/shared";
import { playerStateLine, trimToCompleteSentence } from "./agent.js";
import type { Session } from "./sessions.js";

function mkSession(hp: number, conditions: string[]): Session {
  return {
    id: "t",
    character: { name: "Jão", maxHp: 65 } as unknown as Character,
    state: { sessionId: "t", currentHp: hp, conditions, flags: {}, combat: null },
  } as unknown as Session;
}

describe("playerStateLine (estado nunca mente — vida/consciência)", () => {
  it("estabilizado a 1 HP: ALIVE, machucado, proibido narrar limbo", () => {
    // Cenário exato do play-test 2026-07-12 (o narrador manteve o 'limbo').
    const line = playerStateLine(mkSession(1, ["wounded 1"]));
    expect(line).toContain("ALIVE");
    expect(line).toContain("badly hurt (1/65 HP)");
    expect(line).toContain("NEVER narrate them as dead");
  });

  it("dying: UNCONSCIOUS mas explicitamente NOT dead", () => {
    const line = playerStateLine(mkSession(0, ["dying 2", "unconscious"]));
    expect(line).toContain("UNCONSCIOUS and DYING 2");
    expect(line).toContain("NOT dead");
  });

  it("morto: DEAD e só epílogo", () => {
    const line = playerStateLine(mkSession(0, ["dead"]));
    expect(line).toContain("DEAD");
  });

  it("saudável: sem números de HP (anti dores-fantasma)", () => {
    const line = playerStateLine(mkSession(60, []));
    expect(line).toContain("ALIVE");
    expect(line).not.toContain("/65");
  });
});

describe("trimToCompleteSentence (truncamento de max_tokens)", () => {
  it("apara o rabo de frase incompleta", () => {
    expect(
      trimToCompleteSentence(
        "The door opens. The mechanism groans with the",
      ),
    ).toBe("The door opens.");
  });

  it("mantém texto que já termina completo (incl. aspas/reticências)", () => {
    expect(trimToCompleteSentence("He falls. \"Why?\"")).toBe("He falls. \"Why?\"");
    expect(trimToCompleteSentence("You are plunged into a void…")).toBe(
      "You are plunged into a void…",
    );
  });

  it("sem nenhuma frase completa, devolve como veio", () => {
    expect(trimToCompleteSentence("a mangled husk of metal and sparking wires")).toBe(
      "a mangled husk of metal and sparking wires",
    );
  });
});
