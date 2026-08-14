import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePathbuilder } from "../pathbuilder/parse.js";
import { loadSave, restoreIntoSession, SAVE_MESSAGE_TAIL, saveSession, savePath } from "./save.js";
import { createSession, type Session } from "./sessions.js";

const here = dirname(fileURLToPath(import.meta.url));
const example = JSON.parse(
  readFileSync(join(here, "../../../../exemplo_personagem.json"), "utf8"),
);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "save-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function playedSession(): Session {
  const session = createSession(parsePathbuilder(example));
  session.state.currentHp = 12;
  session.state.conditions = ["frightened 1"];
  session.state.spellSlotsUsed = { "1": 2 };
  session.messages.push(
    { role: "user", content: "I sneak along the ledge." },
    { role: "assistant", content: "The water whispers beneath your boots…" },
  );
  return session;
}

describe("save-game round-trip", () => {
  it("salva e restaura personagem, estado e fio narrativo", () => {
    const session = playedSession();
    saveSession(session, dir);

    const save = loadSave(dir);
    expect(save).not.toBeNull();
    expect(save!.character.name).toBe(session.character.name);
    expect(save!.state.currentHp).toBe(12);
    expect(save!.state.conditions).toEqual(["frightened 1"]);
    expect(save!.state.spellSlotsUsed).toEqual({ "1": 2 });

    const restored = createSession(save!.character);
    restoreIntoSession(restored, save!);
    // ID novo vence o sessionId antigo do estado salvo.
    expect(restored.state.sessionId).toBe(restored.id);
    expect(restored.state.currentHp).toBe(12);
    expect(restored.messages).toHaveLength(2);
    expect(restored.resumed).toBe(true);
  });

  it("guarda só a cauda do histórico (contexto é orçamento)", () => {
    const session = playedSession();
    session.messages = [];
    for (let i = 0; i < SAVE_MESSAGE_TAIL + 10; i++) {
      session.messages.push({ role: "user", content: `turno ${i}` });
    }
    saveSession(session, dir);
    const save = loadSave(dir)!;
    expect(save.messages).toHaveLength(SAVE_MESSAGE_TAIL);
    expect(save.messages[save.messages.length - 1]).toMatchObject({
      content: `turno ${SAVE_MESSAGE_TAIL + 9}`,
    });
  });

  it("efeitos ativos atravessam o save, com prazo e tudo (Fase 2.6)", () => {
    // "Continue campaign" é o caminho que o jogador usa toda sessão. Um efeito
    // que se perde no save some sem aviso; um que volta sem prazo vira bônus
    // permanente. Os dois erros são invisíveis sem este teste.
    const session = playedSession();
    session.state.effects = [
      {
        slug: "arcane-cascade",
        name: "Stance: Arcane Cascade",
        source: "Arcane Cascade",
        unit: "encounter",
        value: -1,
        expiresOnRound: null,
      },
      {
        slug: "heroism",
        name: "Spell Effect: Heroism",
        source: "Heroism",
        unit: "minutes",
        value: 10,
        expiresOnRound: 100,
      },
    ];
    saveSession(session, dir);

    const restored = createSession(parsePathbuilder(example));
    restoreIntoSession(restored, loadSave(dir)!);
    expect(restored.state.effects).toEqual(session.state.effects);
  });

  it("save ANTERIOR à Fase 2.6 (sem o campo effects) continua carregando", () => {
    // Compat: o campo é opcional de propósito. Save antigo não pode virar
    // "campanha corrompida" só porque a engine ganhou um registro novo.
    const session = playedSession();
    saveSession(session, dir);
    const raw = JSON.parse(readFileSync(savePath(dir), "utf8"));
    delete raw.state.effects;
    writeFileSync(savePath(dir), JSON.stringify(raw));

    const save = loadSave(dir);
    expect(save).not.toBeNull();
    expect(save!.state.effects).toBeUndefined();
  });

  it("save ausente ou corrompido vira null, nunca exceção", () => {
    expect(loadSave(dir)).toBeNull();
    writeFileSync(savePath(dir), "{ not json");
    expect(loadSave(dir)).toBeNull();
    writeFileSync(savePath(dir), JSON.stringify({ version: 2, nope: true }));
    expect(loadSave(dir)).toBeNull();
  });
});
