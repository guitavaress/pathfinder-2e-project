/**
 * O JUIZ da bateria de feats — extraído do harness para ser testável.
 *
 * POR QUE ISTO EXISTE SEPARADO (achado de 2026-07-25): este é o código que
 * decide PASS/FAIL de todos os 75 cenários e não tinha um único teste. Pior:
 * ele era CEGO em 40 deles — reaction, free e passive não tinham nenhuma
 * asserção de que o feat foi de fato usado, e `Nimble Dodge`/`Reactive Shield`
 * passaram sem a reação ter sido gasta uma vez sequer.
 *
 * PRINCÍPIO: asserção proporcional à EVIDÊNCIA. Onde a engine deixa rastro
 * de estado (a reação consumida), o veredito é duro (FAIL). Onde só há
 * heurística de texto (nome do feat nos argumentos), o veredito é SUSPECT.
 * E onde não há NADA observável — a maioria dos passivos, que a engine sequer
 * implementa — o juiz **declara que não asseriu** em vez de fingir que passou.
 * Ponto cego declarado é auditável; ponto cego silencioso vira falso conforto.
 */

// ---------------------------------------------------------------------------
// Tipos compartilhados com o harness
// ---------------------------------------------------------------------------

export interface BatteryFeat {
  name: string;
  level: number | null;
  actionType: string | null;
  actionCost: number | null;
  traits: string[];
}

export interface Scenario extends BatteryFeat {
  side: "combat" | "noncombat";
  archetype: string;
}

export interface CheckEv {
  label: string;
  die: number;
  total: number;
  dc: number;
  degree: string;
  attack?: {
    attacker: string;
    target: string;
    attackerKind: string;
    outcome: string;
    damage: number | null;
    damageType: string | null;
  } | null;
}

export interface TurnResult {
  input: string;
  narrative: string;
  checks: CheckEv[];
  finalState: Record<string, unknown> | null;
  toolLines: string[];
  errorLines: string[];
  seconds: number;
  /** Resumo mecânico que a engine entregou ao narrador (log do servidor). */
  mechanicalSummary?: string;
}

/**
 * O feat foi exercitado? `confirmed` tem evidência; `missing` tem evidência do
 * CONTRÁRIO; `not-asserted` é o ponto cego assumido — o juiz não sabe e diz
 * que não sabe.
 */
export type UsageAssertion =
  | { kind: "confirmed"; how: string }
  | { kind: "missing"; why: string }
  | { kind: "not-asserted"; why: string };

export interface Verdict {
  feat: string;
  side: string;
  archetype: string;
  verdict: "PASS" | "FAIL" | "SUSPECT";
  actionsSpent: number | null;
  toolsUsed: string[];
  notes: string[];
  seconds: number;
  /** Cobertura de asserção — o número que o relatório soma. */
  usage: UsageAssertion;
}

// ---------------------------------------------------------------------------
// Leitura do estado
// ---------------------------------------------------------------------------

interface PlayerShape {
  actionsRemaining?: number;
  reactionAvailable?: boolean;
}

export function playerFromState(
  state: Record<string, unknown> | null,
): PlayerShape | null {
  const combat = (
    state as { combat?: { combatants?: Record<string, unknown>[] } } | null
  )?.combat;
  if (!combat?.combatants) return null;
  return (combat.combatants.find((c) => c.kind === "player") as PlayerShape) ?? null;
}

function combatIsActive(state: Record<string, unknown> | null): boolean {
  return (
    (state as { combat?: { active?: boolean } } | null)?.combat?.active === true
  );
}

/** Normaliza para casar nome de feat em texto livre do modelo. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * O nome do feat aparece nos ARGUMENTOS de uma tool call que a engine aceitou?
 * Só conta a parte antes do `->`: o nome ecoado no RESULTADO da tool (ex.: uma
 * mensagem de rejeição citando o feat) não é prova de uso.
 */
export function featNamedInTools(toolLines: string[], featName: string): boolean {
  const key = norm(featName);
  if (!key) return false;
  return toolLines.some((line) => {
    if (line.includes("-> ERROR")) return false;
    const args = line.split("->")[0] ?? "";
    return norm(args).includes(key);
  });
}

/** Houve ataque de INIMIGO neste turno — o gatilho das reações defensivas. */
export function enemyAttacked(turn: TurnResult): boolean {
  return turn.checks.some((c) => c.attack?.attackerKind === "enemy");
}

/** A engine registrou uma reação disparada (label "Reaction (Nome)"). */
export function reactionInChecks(turn: TurnResult): boolean {
  return turn.checks.some((c) => /reaction\s*\(/i.test(c.label));
}

/**
 * A engine DECLAROU ao narrador que nada foi resolvido neste turno
 * (`buildMechanicalSummary`, doutrina 4: o que não está nas linhas não
 * aconteceu).
 *
 * Distinguir isto de "o modelo fugiu da mecânica" é o segundo falso positivo
 * documentado no ROADMAP: `Esoteric Wayfinder` é uma free action de exploração
 * e o cenário a exercitava numa TAVERNA. A escalação disparou, o modelo
 * respondeu que não se aplicava, e a engine avisou o narrador — o sistema
 * inteiro funcionando. Acusar isso é punir o jogo pelo cenário mal desenhado.
 */
export function engineDeclaredVoid(turn: TurnResult): boolean {
  return /NOTHING was resolved/i.test(turn.mechanicalSummary ?? "");
}

/**
 * Passivos que a ENGINE realmente implementa hoje (`PASSIVE_FEAT_EFFECTS` em
 * combat.ts). Só estes têm efeito observável; o resto é passivo de prosa e
 * cai honestamente em `not-asserted`. Crescer esta lista junto com a engine.
 */
export const ENGINE_PASSIVES: Record<string, RegExp> = {
  "incredible initiative": /initiative from .*incredible initiative/i,
};

// ---------------------------------------------------------------------------
// A asserção de uso
// ---------------------------------------------------------------------------

/**
 * O feat foi exercitado neste turno? Uma resposta por tipo de ação, cada uma
 * com a evidência que aquele tipo deixa (ou a admissão de que não deixa).
 */
export function assertUsage(s: Scenario, turns: TurnResult[]): UsageAssertion {
  const useTurn = turns[turns.length - 1]!;
  const named = featNamedInTools(useTurn.toolLines, s.name);

  // A engine avisou que nada se aplicava: o cenário não criou as condições do
  // feat. Não dá para afirmar que ele funciona NEM que falhou — ponto cego
  // declarado, não acusação. (Reação segue sendo aferida: lá o gatilho é
  // observável no próprio turno.)
  if (s.actionType !== "reaction" && engineDeclaredVoid(useTurn)) {
    return {
      kind: "not-asserted",
      why: "a engine declarou que nada se aplicava nesta cena — cenário não exercitou o feat",
    };
  }

  if (s.actionType === "reaction") {
    const player = playerFromState(useTurn.finalState);
    // Fora de combate (ou sem estado) não há economia de reação para observar.
    if (!player || typeof player.reactionAvailable !== "boolean") {
      return {
        kind: "not-asserted",
        why: "sem estado de combate para observar a economia de reação",
      };
    }
    const consumed = player.reactionAvailable === false;
    if (consumed || reactionInChecks(useTurn)) {
      return { kind: "confirmed", how: "reação consumida pela engine" };
    }
    if (!enemyAttacked(useTurn)) {
      return {
        kind: "not-asserted",
        why: "o gatilho não ocorreu no turno (nenhum ataque inimigo)",
      };
    }
    return {
      kind: "missing",
      why: "o inimigo atacou (gatilho servido) e a reação do jogador seguiu DISPONÍVEL",
    };
  }

  if (s.actionType === "free") {
    // Free action não gasta ação nem reação: não há rastro de estado. Só
    // resta a heurística do nome nos argumentos — daí o veredito ser SUSPECT.
    return named
      ? { kind: "confirmed", how: "feat citado nos argumentos de uma tool aceita" }
      : { kind: "missing", why: "o feat não aparece nos argumentos de nenhuma tool aceita" };
  }

  if (s.actionType === "passive") {
    const signature = ENGINE_PASSIVES[norm(s.name)];
    if (signature) {
      // Passivo se aplica onde o gatilho dele acontece, não necessariamente no
      // turno de uso: a iniciativa é rolada no `start_combat` do turno 1,
      // enquanto o turno de uso é o último. Procura em TODOS os turnos.
      const everything = turns.flatMap((t) => t.toolLines).join("\n");
      return signature.test(everything)
        ? { kind: "confirmed", how: "efeito passivo aplicado pela engine aparece no resumo" }
        : { kind: "missing", why: "a engine implementa este passivo mas o efeito não apareceu" };
    }
    return {
      kind: "not-asserted",
      why: "passivo sem efeito mecânico implementado na engine — nada observável",
    };
  }

  // actionType "action" (ou ausente): o custo cobrado já é a evidência forte em
  // combate; fora dele, resta o nome nos argumentos ou uma rolagem.
  if (s.side === "combat") {
    const player = playerFromState(useTurn.finalState);
    const spent =
      player && typeof player.actionsRemaining === "number"
        ? 3 - player.actionsRemaining
        : null;
    if (spent !== null && spent >= (s.actionCost ?? 1)) {
      return { kind: "confirmed", how: `custo de ação cobrado (${spent})` };
    }
    if (named) {
      return { kind: "confirmed", how: "feat citado nos argumentos de uma tool aceita" };
    }
    return { kind: "missing", why: "nem custo de ação cobrado nem feat citado em tool aceita" };
  }
  if (named || useTurn.checks.length > 0) {
    return {
      kind: "confirmed",
      how: named ? "feat citado nos argumentos de uma tool aceita" : "resolveu com rolagem",
    };
  }
  return { kind: "missing", why: "nenhuma tool citou o feat e nenhuma rolagem aconteceu" };
}

// ---------------------------------------------------------------------------
// Falso golpe narrado
// ---------------------------------------------------------------------------

const BLOW_SUBJECT = /\b(blade|dagger|sword|strike|blow|fist|steel|axe|spear|arrow|bolt)\b/i;
const BLOW_VERB =
  /\b(sinks|buries|slams into|connects|lands (?:solidly|squarely|true)|bites into|tears through|pierces)\b/i;

/**
 * Negação/erro na MESMA frase. Sem isto o juiz acusava "golpe conectando" em
 * narrações que diziam o oposto ("your blade never connects", "the strike
 * fails to bite into the shield") — o falso positivo documentado do
 * `Flying Blade`. Cobre negação explícita, verbos de erro e defesa do alvo.
 */
const NEGATION =
  /\b(no|not|n't|never|nothing|fails? to|failing to|barely|nearly|almost|instead of|without|misses?|missed|missing|dodges?|dodged|parries|parried|deflects?|deflected|blocks?|blocked|turns? aside|glances? off|goes wide|wide of|short of)\b/i;

/** Frases da narração (mantém a pontuação para não colar orações vizinhas). */
function sentencesOf(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+/);
}

/**
 * A narração descreve um golpe CONECTANDO? Só conta quando a frase não carrega
 * negação — é a diferença entre "a lâmina crava" e "a lâmina não crava".
 */
export function narratesLandedBlow(narrative: string): boolean {
  return sentencesOf(narrative).some(
    (sentence) =>
      BLOW_SUBJECT.test(sentence) &&
      BLOW_VERB.test(sentence) &&
      !NEGATION.test(sentence),
  );
}

// ---------------------------------------------------------------------------
// O juiz
// ---------------------------------------------------------------------------

export function judge(s: Scenario, turns: TurnResult[]): Verdict {
  const notes: string[] = [];
  let verdict: Verdict["verdict"] = "PASS";
  const useTurn = turns[turns.length - 1]!;
  const toolsUsed = [
    ...new Set(
      useTurn.toolLines.map((l) => l.match(/tool (\w+)\(/)?.[1] ?? "").filter(Boolean),
    ),
  ];

  /** Rebaixa o veredito sem nunca promovê-lo (FAIL > SUSPECT > PASS). */
  const demote = (to: "FAIL" | "SUSPECT", note: string) => {
    notes.push(note);
    if (to === "FAIL") verdict = "FAIL";
    else if (verdict === "PASS") verdict = "SUSPECT";
  };

  // --- Economia de ação (só no turno de uso, em combate, para feats com custo).
  let actionsSpent: number | null = null;
  const player = playerFromState(useTurn.finalState);
  const combatActive = combatIsActive(useTurn.finalState);
  if (s.side === "combat" && player && typeof player.actionsRemaining === "number") {
    actionsSpent = 3 - player.actionsRemaining;
    if (
      s.actionType === "action" &&
      (s.actionCost ?? 0) >= 1 &&
      combatActive &&
      actionsSpent < (s.actionCost ?? 0)
    ) {
      demote("FAIL", `custo de ação não cobrado: feat custa ${s.actionCost}, turno gastou ${actionsSpent}`);
    }
  }

  // --- ASSERÇÃO DE USO (o conserto de 2026-07-25).
  const usage = assertUsage(s, turns);
  if (usage.kind === "missing") {
    // Evidência de ESTADO (reação consumida) é dura; heurística de nome é branda.
    if (s.actionType === "reaction" || s.actionType === "passive") {
      demote("FAIL", `feat NÃO usado: ${usage.why}`);
    } else {
      demote("SUSPECT", `feat provavelmente não usado: ${usage.why}`);
    }
  } else if (usage.kind === "not-asserted") {
    notes.push(`sem asserção de uso: ${usage.why}`);
  }

  // --- DC inválido passou pela engine? (não deveria ser possível)
  for (const c of useTurn.checks) {
    if (!c.attack && c.dc < 5) {
      demote("FAIL", `check com DC inválido (${c.dc}) escapou do guard`);
    }
  }

  // --- Golpe narrado sem mecânica correspondente.
  const anyHit = useTurn.checks.some(
    (c) => c.attack && (c.attack.outcome === "hit" || c.attack.outcome === "criticalHit"),
  );
  if (s.side === "combat" && !anyHit && narratesLandedBlow(useTurn.narrative)) {
    demote("FAIL", "narrativa descreve golpe conectando, mas nenhum hit mecânico ocorreu");
  }

  // --- Dupla contagem: hit da engine + hpDelta manual aceito no mesmo turno.
  const manualDamage = useTurn.toolLines.some(
    (l) =>
      l.includes("update_state") &&
      /"hpDelta":-\d+/.test(l) &&
      /"target"/.test(l) &&
      !l.includes("-> ERROR"),
  );
  if (anyHit && manualDamage) {
    demote("FAIL", "dupla contagem: hit da engine + hpDelta manual no mesmo turno");
  }

  // --- Erros de tool não recuperados.
  if (useTurn.errorLines.length > 0) {
    const lastError = useTurn.toolLines.lastIndexOf(
      useTurn.errorLines[useTurn.errorLines.length - 1]!,
    );
    const recovered = useTurn.toolLines
      .slice(lastError + 1)
      .some((l) => !l.includes("-> ERROR"));
    if (!recovered && useTurn.checks.length === 0) {
      demote("SUSPECT", `tool errors sem recuperação: ${useTurn.errorLines.length}`);
    } else {
      notes.push(`tool errors recuperados: ${useTurn.errorLines.length}`);
    }
  }

  // --- Nenhuma tool no turno de uso de um feat com custo de ação.
  if (s.side === "combat" && s.actionType === "action" && useTurn.toolLines.length === 0) {
    demote("SUSPECT", "nenhuma tool chamada no turno de uso de um feat com custo de ação");
  }

  // --- Fora de combate: uso ativo sem nenhuma mecânica.
  // skill-activity e downtime são ATIVIDADES por definição (exigem mecânica
  // mesmo quando o Foundry as marca actionType "passive" — caso Sow Rumor).
  const isActivity = s.archetype === "skill-activity" || s.archetype === "downtime";
  if (
    s.side === "noncombat" &&
    (isActivity || s.actionType !== "passive") &&
    useTurn.checks.length === 0 &&
    !toolsUsed.includes("update_state") &&
    // Engine que DECLARA o vazio está cumprindo a doutrina 4, não fugindo dela.
    !engineDeclaredVoid(useTurn)
  ) {
    demote("SUSPECT", "feat ativo fora de combate resolvido sem mecânica alguma");
  }

  return {
    feat: s.name,
    side: s.side,
    archetype: s.archetype,
    verdict,
    actionsSpent,
    toolsUsed,
    notes,
    seconds: turns.reduce((a, t) => a + t.seconds, 0),
    usage,
  };
}
