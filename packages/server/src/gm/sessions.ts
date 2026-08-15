import { randomUUID } from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Character, GameState, TurnRef } from "@pf2e/shared";

export interface Session {
  id: string;
  character: Character;
  state: GameState;
  /** History of messages exchanged with the model (user/assistant/tool). */
  messages: ChatCompletionMessageParam[];
  /** True quando restaurada de um save — o primeiro turno vira recap. */
  resumed?: boolean;
  /** Referências que o JOGADOR fixou neste turno pela paleta da UI (Fase 2.7).
   *  Vivem um turno só — `runTurn` põe na entrada e limpa na saída — porque
   *  são intenção do turno, não estado do jogo: nada disto vai para o save. */
  turnRefs?: TurnRef[];
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
      combat: null,
      companions: [],
    },
    messages: [],
  };
  sessions.set(id, session);
  return session;
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}
