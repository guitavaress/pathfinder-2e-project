/**
 * A referência que o JOGADOR fixa no turno (Fase 2.7 / T7.3).
 *
 * A paleta da UI manda `refs` junto do texto; a engine fixa no turno e o
 * `lookup_rule` consulta ANTES de qualquer coisa que o modelo tenha pedido.
 * É o ponto da doutrina 1 nesta fase: a desambiguação é garantida pela engine,
 * não pedida ao prompt. Se dependesse do modelo repassar a categoria, seria
 * mitigação — e um 12B esquece.
 *
 * Roda sem GPU: `lookup_rule` é resolvido inteiramente em código.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Character, TurnRef } from "@pf2e/shared";
import { executeTool, runTurn } from "./agent.js";
import { parsePathbuilder } from "../pathbuilder/parse.js";
import type { Session } from "./sessions.js";

/**
 * O cliente do modelo, morto na raiz.
 *
 * Sem isto o teste do ciclo de vida dependia do llama-server estar FORA do ar:
 * passava com `gemma-down` e estourava o timeout com o modelo carregado — um
 * teste que mede o ambiente, não o código. `agent.ts` constrói o cliente uma
 * vez, no topo do módulo; o mock precisa vir antes do import (vitest içá-lo).
 */
vi.mock("openai", () => ({
  default: class {
    chat = {
      completions: {
        create: () => Promise.reject(new Error("sem modelo no teste")),
      },
    };
  },
}));

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));
const noop = () => {};

const EXAMPLE = JSON.parse(
  readFileSync(join(here, "../../../../exemplo_personagem.json"), "utf8"),
) as unknown;

function mkSession(over: Partial<Character> = {}, refs?: TurnRef[]): Session {
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
    ...(refs ? { turnRefs: refs } : {}),
  } as unknown as Session;
}

describe.skipIf(!hasGenerated)("lookup_rule com a referência fixada pelo jogador", () => {
  it("sem referência, a colisão é servida pela precedência e DECLARADA", async () => {
    const s = mkSession();
    const out = await executeTool(s, "lookup_rule", { query: "Shake It Off" }, noop);
    expect(out.content).toMatch(/^Shake It Off \(actions\)/);
    expect(out.content).toMatch(/does NOT settle it/);
  });

  it("com a referência do jogador, vem o FEAT — e a nota deixa de fingir dúvida", async () => {
    const s = mkSession({}, [{ name: "Shake It Off", category: "feats" }]);
    const out = await executeTool(s, "lookup_rule", { query: "Shake It Off" }, noop);
    expect(out.content).toMatch(/\(feats\)/);
    expect(out.content).toMatch(/rage/i);
    expect(out.content).not.toMatch(/does NOT settle it/);
  });

  it("a referência do jogador vence a categoria que o MODELO pediu", async () => {
    const s = mkSession({}, [{ name: "Shake It Off", category: "feats" }]);
    const out = await executeTool(
      s,
      "lookup_rule",
      { query: "Shake It Off", category: "actions" },
      noop,
    );
    expect(out.content).toMatch(/\(feats\)/);
  });

  it("sem referência, a categoria do modelo ainda vale (reforço, não garantia)", async () => {
    const s = mkSession();
    const out = await executeTool(
      s,
      "lookup_rule",
      { query: "Shake It Off", category: "feats" },
      noop,
    );
    expect(out.content).toMatch(/\(feats\)/);
  });

  it("o uuid da referência dispensa a grafia do nome", async () => {
    // O dado grafa o feat "Shake it Off" e a ação "Shake It Off".
    const s = mkSession({}, [
      { name: "Shake It Off", category: "feats", uuid: "auv1lss6LxM0q3gz" },
    ]);
    const out = await executeTool(s, "lookup_rule", { query: "Shake It Off" }, noop);
    expect(out.content).toMatch(/\(feats\)/);
  });

  it("a referência casa quando o modelo pergunta com sufixo, mas não captura outro nome", async () => {
    const withRef = mkSession({}, [{ name: "Fly", category: "spells" }]);
    // "Fly spell" contém "Fly" → casa.
    const hit = await executeTool(withRef, "lookup_rule", { query: "Fly spell" }, noop);
    expect(hit.content).toMatch(/\(spells\)/);
    // "Fly" NÃO pode capturar a referência de um nome mais longo.
    const other = mkSession({}, [{ name: "Flying Blade", category: "feats" }]);
    const miss = await executeTool(other, "lookup_rule", { query: "Fly" }, noop);
    expect(miss.content).not.toMatch(/Flying Blade/);
  });

  it("referência para outro nome não contamina a consulta", async () => {
    const s = mkSession({}, [{ name: "Bon Mot", category: "feats" }]);
    const out = await executeTool(s, "lookup_rule", { query: "Shake It Off" }, noop);
    expect(out.content).toMatch(/^Shake It Off \(actions\)/);
  });
});

describe("ciclo de vida: a referência vale UM turno", () => {
  it("runTurn limpa a referência mesmo quando o turno falha", async () => {
    // Com o modelo mockado para falhar, `runTurn` captura o erro e emite
    // `error`. O que este teste garante é o `finally`: escolher "Shake It Off"
    // agora não pode reescrever a consulta do turno seguinte.
    const s = mkSession({}, [{ name: "Shake It Off", category: "feats" }]);
    expect(s.turnRefs).toHaveLength(1);
    const events: { type: string }[] = [];
    await runTurn(s, "eu sacudo o medo", (e) => events.push(e as { type: string }));
    expect(events.some((e) => e.type === "error")).toBe(true);
    expect(s.turnRefs).toBeUndefined();
  });

  it("runTurn sem referências não inventa lista vazia no lugar", async () => {
    const s = mkSession();
    await runTurn(s, "olho em volta", noop);
    expect(s.turnRefs).toBeUndefined();
  });
});
