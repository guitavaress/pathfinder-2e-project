import { randomUUID } from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Character, GameState } from "@pf2e/shared";

export interface Session {
  id: string;
  character: Character;
  state: GameState;
  /** History of messages exchanged with the model (user/assistant/tool). */
  messages: ChatCompletionMessageParam[];
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
