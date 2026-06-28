import { randomUUID } from "node:crypto";
import type { Message } from "ollama";
import type { Character, GameState } from "@pf2e/shared";

export interface Session {
  id: string;
  character: Character;
  state: GameState;
  /** Histórico de mensagens trocadas com o modelo (user/assistant/tool). */
  messages: Message[];
}

const sessions = new Map<string, Session>();

export function createSession(character: Character): Session {
  const id = randomUUID();
  const session: Session = {
    id,
    character,
    state: {
      sessionId: id,
      currentHp: character.maxHp,
      conditions: [],
      flags: {},
    },
    messages: [],
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}
