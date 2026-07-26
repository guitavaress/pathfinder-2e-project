/**
 * Gate narrativo "uma voz por vez" (Fase 2, ADR-004).
 *
 * O 12B borra personalidades quando encarna várias de uma vez — o teto não é
 * "quantos NPCs existem", é quantas VOZES entram no mesmo contexto. Este gate
 * decide, EM CÓDIGO, qual companheiro (no máximo um) pode falar no turno; só a
 * persona dele é injetada no narrador. Os demais ficam explicitamente mudos.
 *
 * Prioridade (determinística, auditável):
 *   1. EVENTO mecânico do companheiro no turno (caiu > entrou/saiu da party >
 *      tomou dano > acertou crítico) — extraído das linhas do resumo, a fonte
 *      que não mente;
 *   2. MENÇÃO: o jogador citou o companheiro pela mensagem;
 *   3. BANTER: cadência determinística (a cada BANTER_EVERY turnos, rotativo);
 *   4. Silêncio.
 */
import type { Companion } from "@pf2e/shared";
import { normalizeName } from "./combat.js";

/** A cada quantos turnos um companheiro puxa conversa sem gancho mecânico. */
export const BANTER_EVERY = 3;

export type VoiceReason =
  | "went-down"
  | "joined-or-left"
  | "took-damage"
  | "dealt-crit"
  | "mentioned"
  | "banter";

export interface VoicePick {
  companion: Companion;
  reason: VoiceReason;
}

/** Evento mecânico do companheiro nas linhas do resumo (ordem = prioridade). */
function eventOf(name: string, mechanical: string): VoiceReason | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (new RegExp(`${esc} goes DOWN`, "i").test(mechanical)) return "went-down";
  if (new RegExp(`${esc} (joins|leaves) the party`, "i").test(mechanical)) {
    return "joined-or-left";
  }
  // Alvo de um golpe que conectou: "vs <name> ... → HIT/CRITICAL HIT".
  if (new RegExp(`vs ${esc}[^\\n]*(?:CRITICAL )?HIT`, "i").test(mechanical)) {
    return "took-damage";
  }
  // Atacante que critou: "<name> ... Strike vs ... → CRITICAL HIT".
  if (new RegExp(`${esc} [^\\n]*Strike vs [^\\n]*CRITICAL HIT`, "i").test(mechanical)) {
    return "dealt-crit";
  }
  return null;
}

const EVENT_PRIORITY: VoiceReason[] = [
  "went-down",
  "joined-or-left",
  "took-damage",
  "dealt-crit",
];

/**
 * Decide quem (se alguém) fala neste turno. `turn` é um contador monotônico
 * de turnos do jogador (dirige a cadência de banter).
 */
export function pickVoice(
  companions: Companion[],
  opts: { playerText: string; mechanical: string; turn: number },
): VoicePick | null {
  if (companions.length === 0) return null;

  // 1. Evento mecânico — o beat mais forte vence; empate decide pela ordem do
  // roster (quem entrou primeiro fala primeiro: determinístico e estável).
  const events = companions
    .map((c) => ({ companion: c, reason: eventOf(c.name, opts.mechanical) }))
    .filter((e): e is VoicePick => e.reason !== null);
  for (const priority of EVENT_PRIORITY) {
    const hit = events.find((e) => e.reason === priority);
    if (hit) return hit;
  }

  // 2. Menção do jogador (fuzzy nos dois sentidos, como no combate).
  const text = normalizeName(opts.playerText);
  if (text) {
    const mentioned = companions.find((c) => {
      const n = normalizeName(c.name);
      // Só o nome contido na mensagem — mensagem contida no nome seria ruído.
      return n.length > 0 && text.includes(n);
    });
    if (mentioned) return { companion: mentioned, reason: "mentioned" };
  }

  // 3. Banter em cadência, rotativo pelo roster.
  if (opts.turn > 0 && opts.turn % BANTER_EVERY === 0) {
    const idx = Math.floor(opts.turn / BANTER_EVERY - 1) % companions.length;
    return { companion: companions[idx]!, reason: "banter" };
  }

  return null;
}

/**
 * A diretiva injetada no narrador. "" sem companheiros; com companheiros e
 * ninguém escolhido, a ordem explícita de silêncio — sem ela o narrador dubla
 * todo mundo em todo turno, exatamente o modo de falha que o ADR-004 fecha.
 */
export function voiceDirective(
  pick: VoicePick | null,
  companions: Companion[],
): string {
  if (companions.length === 0) return "";
  const names = companions.map((c) => c.name).join(", ");
  if (!pick) {
    return `[COMPANIONS: ${names} — present but in the background this turn. Do NOT give any companion dialogue; a gesture or glance at most.]`;
  }
  const c = pick.companion;
  const voice = c.persona.trim()
    ? c.persona.trim()
    : "no recorded persona — keep them terse and consistent with their past behavior";
  const others = companions.filter((x) => x.id !== c.id).map((x) => x.name);
  const silence = others.length
    ? ` The other companions (${others.join(", ")}) stay silent this turn.`
    : "";
  return `[COMPANION VOICE: this turn ${c.name} may speak — at most a line or two of dialogue, in THEIR voice: ${voice}.${silence} Never invent dialogue for anyone not named here.]`;
}
