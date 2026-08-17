/**
 * Ações de perícia com CONSEQUÊNCIA — Demoralize aplica frightened, Trip
 * aplica prone, Grapple aplica grabbed.
 *
 * ## Por que isto é código e não dado
 *
 * Censo de 2026-08-16 sobre `actions.json`: as 16 ações de perícia mais usadas
 * do jogo têm **ZERO rule elements**. O dado traz o custo, o texto e os quatro
 * graus de sucesso em prosa — e nomeia a condição em inglês no meio da frase
 * ("The target becomes Frightened 2"), mas nada disso é legível por máquina.
 * Não é omissão do importador: o Foundry também não automatiza Demoralize,
 * porque na mesa quem aplica a condição é o GM humano.
 *
 * Então esta tabela é uma EXCEÇÃO DECLARADA à doutrina 3 ("regras como dados"),
 * do mesmo tipo que o ADR-012 nomeia: onde a fonte não tem mecânica, código
 * honesto vale mais que prosa ignorada. O que a torna aceitável é o teste de
 * conformidade em `skill-actions.test.ts`: cada entrada só passa se a condição
 * que ela aplica APARECER no texto oficial daquela ação, no grau declarado. A
 * tabela não pode divergir da fonte sem o teste acusar.
 *
 * ## O que ela conserta
 *
 * Até aqui `roll_check` de perícia rolava o d20 e PARAVA (`agent.ts`): o
 * `summaryLine` de um Demoralize bem-sucedido era idêntico ao de "olhar feio
 * para o inimigo". A única ação de perícia com efeito real no sistema inteiro
 * era Treat Wounds, que tem tool própria.
 *
 * ## O que ela deliberadamente NÃO faz
 *
 * - **Duração.** Grapple dura "até o fim do seu próximo turno", Feint "até o
 *   próximo ataque". A engine não tem relógio para isso fora do tick de fim de
 *   rodada, então a condição entra e expira pelo upkeep normal — aproximação
 *   DECLARADA, não silenciosa.
 * - **Imunidade temporária.** Demoralize dá imunidade de 10 minutos ao alvo; a
 *   engine não modela esse relógio.
 * - **Requisitos de posição.** Feint exige alcance corpo a corpo, Trip exige
 *   mão livre e tamanho. Sem estado posicional (ADR-011), não dá para checar —
 *   e inventar a checagem seria pior que não fazê-la.
 * - **Dano.** O crítico de Trip causa 1d6; dano por ação de perícia fica fora
 *   desta primeira leva, que é sobre CONDIÇÃO.
 */
import type { DegreeOfSuccess } from "@pf2e/shared";

/** Em quem a condição cai: no alvo, ou em quem agiu (críticos que saem pela culatra). */
export type ConditionTarget = "target" | "self";

export interface SkillActionOutcome {
  /** Condição oficial, no formato do estado ("frightened 2", "prone"). */
  condition: string;
  on: ConditionTarget;
}

export interface SkillActionSpec {
  /** Nome como no dataset — a chave do teste de conformidade. */
  name: string;
  /** Perícia que a ação usa, para casar com o `skill` da tool. */
  skill: string;
  /** O que acontece em cada grau. Grau ausente = nada acontece, e isso é RAW. */
  outcomes: Partial<Record<DegreeOfSuccess, SkillActionOutcome>>;
}

/**
 * A tabela. Cada entrada cita o RAW que ela implementa — quem mexer aqui tem
 * de mexer olhando a regra, não a memória.
 */
export const SKILL_ACTIONS: SkillActionSpec[] = [
  {
    // "Critical Success The target becomes Frightened 2. Success ... Frightened 1."
    name: "Demoralize",
    skill: "intimidation",
    outcomes: {
      criticalSuccess: { condition: "frightened 2", on: "target" },
      success: { condition: "frightened 1", on: "target" },
    },
  },
  {
    // "Critical Success The target falls, lands Prone [+1d6]. Success ... prone.
    //  Critical Failure You lose your balance, fall, and land prone."
    name: "Trip",
    skill: "athletics",
    outcomes: {
      criticalSuccess: { condition: "prone", on: "target" },
      success: { condition: "prone", on: "target" },
      criticalFailure: { condition: "prone", on: "self" },
    },
  },
  {
    // "Critical Success Your target is restrained... Success ... grabbed..."
    name: "Grapple",
    skill: "athletics",
    outcomes: {
      criticalSuccess: { condition: "restrained", on: "target" },
      success: { condition: "grabbed", on: "target" },
    },
  },
  {
    // "Critical Success The target is Off Guard against melee attacks...
    //  Success The target is off-guard against the next melee attack...
    //  Critical Failure You are off-guard against melee attacks the target attempts"
    name: "Feint",
    skill: "deception",
    outcomes: {
      criticalSuccess: { condition: "off-guard", on: "target" },
      success: { condition: "off-guard", on: "target" },
      criticalFailure: { condition: "off-guard", on: "self" },
    },
  },
  {
    // ATENÇÃO — Shove NÃO derruba. O RAW: "Critical Success You push your
    // target up to 10 feet away from you. Success You push your target back 5
    // feet. Critical Failure You lose your balance, fall, and land Prone."
    //
    // A primeira versão desta tabela aplicava `prone` no alvo em crítico de
    // sucesso, escrito de memória. O teste de conformidade pegou. É o melhor
    // argumento a favor dele: memória de regra de PF2e não é fonte.
    //
    // O empurrão em si é MOVIMENTO, que a engine não tem estado para modelar
    // (ADR-011) — então só o tombo de quem errou feio vira mecânica.
    name: "Shove",
    skill: "athletics",
    outcomes: {
      criticalFailure: { condition: "prone", on: "self" },
    },
  },
];

const byName = new Map(SKILL_ACTIONS.map((s) => [s.name.toLowerCase(), s]));

/**
 * A ação de perícia que este `roll_check` está resolvendo, se houver.
 *
 * Casa pelo NOME citado no texto do turno E pela perícia usada: "eu intimido o
 * goblin" com `skill: "intimidation"` é Demoralize; "eu rolo intimidação para
 * lembrar de uma história" não é. Exigir os dois evita aplicar condição por
 * causa de uma palavra solta na prosa — que é o erro que este módulo não pode
 * cometer, porque ele MUDA O ESTADO.
 */
export function skillActionFor(text: string, skill: string): SkillActionSpec | null {
  const t = text.toLowerCase();
  const s = skill.toLowerCase().trim();
  for (const spec of SKILL_ACTIONS) {
    if (spec.skill !== s) continue;
    if (new RegExp(`\\b${spec.name.toLowerCase()}\\b`).test(t)) return spec;
  }
  return null;
}

/** O que a ação causa neste grau — `null` quando o grau não causa nada (RAW). */
export function outcomeOf(
  spec: SkillActionSpec,
  degree: DegreeOfSuccess,
): SkillActionOutcome | null {
  return spec.outcomes[degree] ?? null;
}

export function skillActionByName(name: string): SkillActionSpec | null {
  return byName.get(name.toLowerCase()) ?? null;
}
