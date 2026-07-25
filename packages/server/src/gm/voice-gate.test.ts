/**
 * T4 da Fase 2 (ADR-004): o gate "uma voz por vez" — puro, sem GPU.
 * A decisão de quem fala é da ENGINE; o modelo só dubla o escolhido.
 */
import { describe, expect, it } from "vitest";
import type { Companion } from "@pf2e/shared";
import { BANTER_EVERY, pickVoice, voiceDirective } from "./voice-gate.js";

function comp(name: string, persona = `Voz de ${name}.`): Companion {
  return {
    id: name.toLowerCase(),
    name,
    level: 1,
    ac: 15,
    maxHp: 20,
    currentHp: 20,
    perception: 5,
    conditions: [],
    traits: [],
    persona,
  };
}

const quiet = { playerText: "I keep walking.", mechanical: "", turn: 1 };

describe("pickVoice — prioridade", () => {
  it("sem companheiros → null; turno sem gancho → null", () => {
    expect(pickVoice([], quiet)).toBeNull();
    expect(pickVoice([comp("Sela")], quiet)).toBeNull();
  });

  it("evento mecânico vence menção: quem CAIU fala, mesmo com outro citado", () => {
    const roster = [comp("Sela"), comp("Tobin")];
    const pick = pickVoice(roster, {
      playerText: "Tobin, watch out!",
      mechanical: "3. Foe Strike vs Sela → HIT for 8; Sela 8→0 HP — Sela goes DOWN.",
      turn: 1,
    });
    expect(pick).toMatchObject({ companion: { name: "Sela" }, reason: "went-down" });
  });

  it("cair vence tomar dano; tomar dano vence crit dado", () => {
    const roster = [comp("Sela"), comp("Tobin"), comp("Vex")];
    const pick = pickVoice(roster, {
      playerText: "",
      mechanical: [
        "1. Vex Strike vs Foe → CRITICAL HIT for 12.",
        "2. Foe Strike vs Tobin → HIT for 5; Tobin 20→15 HP.",
        "3. Foe Strike vs Sela → HIT for 9; Sela 9→0 HP — Sela goes DOWN.",
      ].join("\n"),
      turn: 1,
    });
    expect(pick?.companion.name).toBe("Sela");
    const noDown = pickVoice(roster, {
      playerText: "",
      mechanical: [
        "1. Vex Strike vs Foe → CRITICAL HIT for 12.",
        "2. Foe Strike vs Tobin → HIT for 5; Tobin 20→15 HP.",
      ].join("\n"),
      turn: 1,
    });
    expect(noDown).toMatchObject({ companion: { name: "Tobin" }, reason: "took-damage" });
  });

  it("entrar na party é gancho de fala", () => {
    const pick = pickVoice([comp("Sela")], {
      playerText: "",
      mechanical: "1. Sela joins the party.",
      turn: 1,
    });
    expect(pick?.reason).toBe("joined-or-left");
  });

  it("golpe que ERROU no companheiro não é gancho", () => {
    const pick = pickVoice([comp("Sela")], {
      playerText: "",
      mechanical: "1. Foe Strike vs Sela → MISS.",
      turn: 1,
    });
    expect(pick).toBeNull();
  });

  it("menção do jogador (case-insensitive, nome dentro da frase)", () => {
    const roster = [comp("Sela"), comp("Tobin")];
    const pick = pickVoice(roster, {
      playerText: "I ask TOBIN about the ruins.",
      mechanical: "",
      turn: 1,
    });
    expect(pick).toMatchObject({ companion: { name: "Tobin" }, reason: "mentioned" });
  });

  it("banter: dispara na cadência, rotaciona pelo roster e é determinístico", () => {
    const roster = [comp("Sela"), comp("Tobin")];
    const at = (turn: number) => pickVoice(roster, { ...quiet, turn });
    expect(at(BANTER_EVERY)?.reason).toBe("banter");
    expect(at(BANTER_EVERY)?.companion.name).toBe("Sela");
    expect(at(BANTER_EVERY * 2)?.companion.name).toBe("Tobin");
    expect(at(BANTER_EVERY * 3)?.companion.name).toBe("Sela");
    expect(at(BANTER_EVERY + 1)).toBeNull();
    // Mesmo turno → mesma escolha (nada de RNG).
    expect(at(BANTER_EVERY * 2)).toEqual(at(BANTER_EVERY * 2));
  });
});

describe("voiceDirective", () => {
  it("sem companheiros → string vazia (nenhum ruído no prompt)", () => {
    expect(voiceDirective(null, [])).toBe("");
  });

  it("ninguém escolhido → ordem explícita de silêncio nomeando o roster", () => {
    const d = voiceDirective(null, [comp("Sela"), comp("Tobin")]);
    expect(d).toContain("Sela, Tobin");
    expect(d).toContain("Do NOT give any companion dialogue");
  });

  it("escolhido → persona DELE + silêncio nomeado dos outros", () => {
    const roster = [comp("Sela", "Seca, leal, odeia agradecimentos."), comp("Tobin")];
    const d = voiceDirective({ companion: roster[0]!, reason: "took-damage" }, roster);
    expect(d).toContain("Sela may speak");
    expect(d).toContain("Seca, leal, odeia agradecimentos.");
    expect(d).toContain("(Tobin) stay silent");
    // A persona do Tobin NÃO vaza para o contexto.
    expect(d).not.toContain("Voz de Tobin.");
  });

  it("companheiro sem persona registrada ganha instrução conservadora", () => {
    const solo = [comp("Sela", "")];
    const d = voiceDirective({ companion: solo[0]!, reason: "banter" }, solo);
    expect(d).toContain("no recorded persona");
    expect(d).not.toContain("stay silent"); // não há outros a silenciar
  });
});
