/**
 * O registro de efeitos ativos (Fase 2.6 / T6.1).
 *
 * A Fase 2.5 parou num teto nomeado no ADR-008: sem saber que efeitos estão
 * ativos, `self:effect:<slug>` é indecidível e os 2.674 docs de `effects.json`
 * que carregam rule elements — 1.949 `FlatModifier`, 378 `Resistance`, 308
 * `DamageDice`, 221 `TempHP` — são prosa. Este módulo é a metade do estado:
 * conceder, guardar e expirar. Ler os rule elements é a T6.2.
 *
 * ## Por que o registro guarda duração e não prazo
 *
 * Todos os 2.815 effects têm `effectDuration` estruturado, em 6 unidades
 * (`minutes` 862, `rounds` 786, `unlimited` 781, `hours` 215, `encounter` 89,
 * `days` 82). Rodada só existe dentro de combate — então o prazo em rodadas é
 * calculado na CONCESSÃO quando há combate, e fora dele fica `null`: o prazo
 * passa a ser o próximo descanso. Guardar a unidade crua deixa essa decisão
 * onde ela é decidível.
 *
 * `minutes` vira rodada por conversão RAW (1 minuto = 10 rodadas), não por
 * chute. `hours`/`days` não têm relógio nesta engine: expiram no descanso, e
 * isso é dívida DECLARADA, não silêncio.
 *
 * ## O efeito precisa existir no dado
 *
 * `resolveEffect` só devolve o que está em `effects.json`. Nome que o modelo
 * inventar é rejeitado de forma auditável — doutrina 4: o estado nunca mente.
 */
import type { ActiveEffect } from "@pf2e/shared";
import { categoryRecords, effectRecord, type RuleRecord } from "./dataset.js";
import { slug } from "./roll-options.js";

/** Unidades de duração do dado, como o schema do estado as guarda. */
export type DurationUnit = ActiveEffect["unit"];

const UNITS = new Set<string>(["rounds", "minutes", "hours", "days", "encounter", "unlimited"]);

/** 1 minuto = 10 rodadas (RAW). É conversão exata, não aproximação. */
const ROUNDS_PER_MINUTE = 10;

/** Os três limites de tempo que esta engine realmente tem. */
export type ExpiryEvent = "round" | "combat-end" | "rest";

export interface ResolvedEffect {
  /** Nome exato do doc ("Effect: Rage"). */
  name: string;
  /** Slug sem o prefixo "Effect: " — o que `self:effect:<slug>` casa. */
  slug: string;
  unit: DurationUnit;
  value: number;
  record: RuleRecord;
}

/**
 * Os prefixos de nome que `effects.json` realmente usa, medidos: `Effect`
 * (2.076), `Spell Effect` (500), `Stance` (86), `Aura` (13), `Mixed Drink` (4),
 * `Spell Effects` (1). Lista fechada de propósito — remover "qualquer coisa
 * antes do dois-pontos" mutilaria nome legítimo.
 */
const NAME_PREFIX = /^(spell effects?|mixed drink|effect|stance|aura):\s*/i;

/**
 * "Effect: Rage" → "rage"; "Stance: Arcane Cascade" → "arcane-cascade".
 *
 * O prefixo é convenção de nome do compêndio, não parte da identidade: o
 * predicado casa contra o slug do item concedido, que não o carrega. Aferido
 * contra o dado — com esta regra, **105 dos 113** statements `*:effect:*`
 * distintos do dataset resolvem para um effect existente (contra 54 se só o
 * prefixo "Effect:" saísse). Os 8 órfãos vêm de módulos fora do core.
 */
export function effectSlugOf(name: string): string {
  return slug(name.replace(NAME_PREFIX, ""));
}

/**
 * Os slugs pelos quais um efeito pode ser referido. O nome COM prefixo também
 * conta: parte dos predicados do dado casa contra ele.
 */
export function effectSlugAliases(name: string): string[] {
  const stripped = effectSlugOf(name);
  const raw = slug(name);
  return raw === stripped ? [stripped] : [stripped, raw];
}

function durationOf(raw: unknown): { unit: DurationUnit; value: number } {
  const d = (raw ?? {}) as { unit?: unknown; value?: unknown };
  const unit = typeof d.unit === "string" && UNITS.has(d.unit) ? (d.unit as DurationUnit) : null;
  const value = typeof d.value === "number" && Number.isFinite(d.value) ? d.value : -1;
  // Sem unidade reconhecida o efeito não ganha prazo inventado: fica sem prazo
  // automático, e sai do registro por remoção explícita, fim de combate ou
  // descanso — nunca por um número que a engine chutou.
  return unit ? { unit, value } : { unit: "unlimited", value: -1 };
}

/** O effect do dado, por nome exato ou uuid. `null` quando não existe. */
export function resolveEffect(ref: string): ResolvedEffect | null {
  const rec = effectRecord(ref);
  if (!rec) return null;
  return { name: rec.name, slug: effectSlugOf(rec.name), ...durationOf(rec.effectDuration), record: rec };
}

/**
 * A rodada em que o efeito expira, ou `null` quando a engine não tem relógio
 * para ele (fora de combate, ou duração em horas/dias/sem prazo).
 *
 * `value - 1` porque o tick roda no FIM da rodada: um efeito de 1 rodada
 * concedido na rodada 3 cobre a rodada 3 e sai no fim dela, que é onde o
 * `turn-start` do pf2e (1.814 dos 2.815) efetivamente cai neste engine de "uma
 * mensagem = uma rodada". `rounds: 0` ("até o fim deste turno") expira no mesmo
 * tick, sem virar rodada negativa.
 */
export function expiryRound(
  unit: DurationUnit,
  value: number,
  round: number | null,
): number | null {
  if (round === null) return null;
  if (unit === "rounds") return round + Math.max(0, value - 1);
  if (unit === "minutes") return round + Math.max(0, value * ROUNDS_PER_MINUTE - 1);
  return null;
}

export interface GrantResult {
  effects: ActiveEffect[];
  /** O efeito concedido, ou null quando o dado não conhece o nome. */
  granted: ActiveEffect | null;
  /** Por que não concedeu — auditável, nunca silencioso. */
  rejected?: string;
  /** true quando já estava ativo e a duração foi renovada (RAW: reaplicar
   *  substitui, não empilha). */
  refreshed?: boolean;
}

/**
 * Concede um efeito, devolvendo a lista nova (não muta a de entrada).
 *
 * Reaplicar um efeito que já está ativo REPÕE a duração em vez de empilhar —
 * é a regra do pf2e, e evita que um mesmo bônus entre duas vezes na pilha de
 * modificadores.
 */
export function grantEffect(
  current: readonly ActiveEffect[],
  ref: string,
  source: string,
  round: number | null = null,
): GrantResult {
  const resolved = resolveEffect(ref);
  if (!resolved) {
    return {
      effects: [...current],
      granted: null,
      rejected: `no effect named "${ref}" in the dataset`,
    };
  }
  const entry: ActiveEffect = {
    slug: resolved.slug,
    name: resolved.name,
    source,
    unit: resolved.unit,
    value: resolved.value,
    expiresOnRound: expiryRound(resolved.unit, resolved.value, round),
  };
  const had = current.some((e) => e.slug === entry.slug);
  return {
    effects: [...current.filter((e) => e.slug !== entry.slug), entry],
    granted: entry,
    ...(had ? { refreshed: true } : {}),
  };
}

/** Remove um efeito pelo slug (dissipar, terminar, perder a condição de manter). */
export function removeEffect(
  current: readonly ActiveEffect[],
  slugOrName: string,
): { effects: ActiveEffect[]; removed: ActiveEffect | null } {
  const key = effectSlugOf(slugOrName);
  const hit = current.find((e) => e.slug === key) ?? null;
  return { effects: current.filter((e) => e.slug !== key), removed: hit };
}

export interface ExpiryResult {
  effects: ActiveEffect[];
  expired: ActiveEffect[];
}

/**
 * Expira o que venceu no limite de tempo dado.
 *
 * - `round` (fim de rodada de combate): sai o que tem prazo em rodadas vencido.
 * - `combat-end`: sai `encounter`, e também o que tinha prazo em rodadas — ele
 *   não sobrevive à luta em que foi concedido.
 * - `rest` (noturno): sai tudo que tem prazo de qualquer espécie. Só
 *   `unlimited` atravessa o descanso.
 *
 * Efeito com prazo em rodadas concedido FORA de combate (`expiresOnRound`
 * null) não tem como ser tickado por rodada — sai no primeiro limite seguinte.
 * Dívida declarada, não erro silencioso.
 */
export function expireEffects(
  current: readonly ActiveEffect[],
  event: ExpiryEvent,
  round: number | null = null,
): ExpiryResult {
  const expired: ActiveEffect[] = [];
  const kept: ActiveEffect[] = [];
  for (const e of current) {
    if (isExpired(e, event, round)) expired.push(e);
    // Quem sobrevive ao fim da luta PERDE o relógio: a numeração de rodadas
    // recomeça em 1 no próximo combate, e um prazo calculado na luta anterior
    // comparado contra ela nunca venceria. `anchorToRound` reancora na entrada.
    else if (event === "combat-end" && e.expiresOnRound !== null) {
      kept.push({ ...e, expiresOnRound: null });
    } else kept.push(e);
  }
  return { effects: kept, expired };
}

function isExpired(e: ActiveEffect, event: ExpiryEvent, round: number | null): boolean {
  if (e.unit === "unlimited") return false;
  switch (event) {
    case "round":
      return e.expiresOnRound !== null && round !== null && round >= e.expiresOnRound;
    case "combat-end":
      // Só o que não pode sobreviver à luta por definição: `encounter` (dura o
      // encontro) e `rounds` (uma luta tem mais rodadas que qualquer prazo
      // desses). `minutes` NÃO entra: uma luta dura ~1 minuto, e matar um
      // Heroism de 10 minutos aqui destruiria um slot de círculo 3 que o
      // jogador pagou. Dos dois erros possíveis, expirar cedo é o pior —
      // expirar tarde é limitado pelo descanso.
      return e.unit === "encounter" || e.unit === "rounds";
    case "rest":
      return true;
  }
}

/**
 * Entra em combate: quem foi concedido fora dele ganha prazo em rodadas agora
 * que existe um relógio. Sem isso um efeito de 1 rodada pego na exploração
 * duraria a luta inteira.
 */
export function anchorToRound(current: readonly ActiveEffect[], round: number): ActiveEffect[] {
  return current.map((e) =>
    e.expiresOnRound === null
      ? { ...e, expiresOnRound: expiryRound(e.unit, e.value, round) }
      : e,
  );
}

// ---------------------------------------------------------------------------
// Como o efeito ENTRA (T6.3): que documento, ao ser usado, põe o quê no próprio
// personagem. Duas pontes, ambas medidas no dado — nenhuma suposta.
// ---------------------------------------------------------------------------

let homonyms: Map<string, RuleRecord> | null = null;

/** Effects indexados pelo nome SEM prefixo — "heroism" → "Spell Effect: Heroism". */
function homonymIndex(): Map<string, RuleRecord> {
  if (homonyms) return homonyms;
  homonyms = new Map();
  for (const rec of categoryRecords("effects")) {
    const key = rec.name.replace(NAME_PREFIX, "").toLowerCase().trim();
    // Primeiro-ganha: "Effect: Panache" antes de "Effect: Panache (Temporary)"
    // não é garantido pela ordem do arquivo, então o desempate é o nome mais
    // curto — o efeito base, não a variante.
    const cur = homonyms.get(key);
    if (!cur || rec.name.length < cur.name.length) homonyms.set(key, rec);
  }
  return homonyms;
}

/** Magia hostil: o efeito homônimo vai no ALVO, nunca em quem conjura. */
function isHostileSpell(rec: RuleRecord): boolean {
  return rec.spell?.attack === true || rec.spell?.defense !== undefined;
}

/**
 * O efeito que USAR este documento põe no PRÓPRIO personagem, ou `null`.
 *
 * Três regras, em ordem de confiança, todas aferidas no dataset:
 *
 * 1. **`selfEffect` explícito** (242 feats, 242/242 resolvendo para um effect).
 *    O nome do campo já diz em quem cai — zero ambiguidade.
 * 2. **Stance homônima** (78 dos 86 docs `Stance:` têm ação/feat de mesmo nome).
 *    Postura é auto-dirigida por definição, e é onde vivem justamente os slugs
 *    que a Fase 2.5 mediu como indecidíveis (`arcane-cascade` e família).
 * 3. **Magia benigna homônima** (318 das 381 magias com effect homônimo; as 63
 *    com ataque ou save ficam FORA — o efeito delas incide em quem foi
 *    atingido, e pôr um `Spell Effect: Ill Omen` no conjurador inventaria uma
 *    penalidade contra ele).
 *
 * Ação/feat não-stance com effect homônimo fica de FORA de propósito: o import
 * não carrega em quem o efeito incide, e "Hunt Prey" marca a PRESA, não o
 * caçador. Presumir self ali fabricaria bônus — dívida declarada no ADR-009.
 */
export function selfEffectOf(rec: RuleRecord): ResolvedEffect | null {
  if (rec.selfEffect) {
    const explicit = resolveEffect(rec.selfEffect);
    if (explicit) return explicit;
  }
  const hit = homonymIndex().get(rec.name.toLowerCase().trim());
  if (!hit) return null;
  const isStance = /^stance:\s/i.test(hit.name);
  if (rec.category === "spells") return isHostileSpell(rec) ? null : toResolved(hit);
  return isStance ? toResolved(hit) : null;
}

function toResolved(rec: RuleRecord): ResolvedEffect {
  return {
    name: rec.name,
    slug: effectSlugOf(rec.name),
    ...durationOf(rec.effectDuration),
    record: rec,
  };
}

let triggers: { name: string; rec: RuleRecord }[] | null = null;

/**
 * As ações e feats cujo uso põe um efeito no próprio personagem — o índice de
 * GATILHO, para reconhecer "entra em Arcane Cascade" na prosa da tool.
 *
 * Nome com menos de 6 letras fica fora: o corpus de `reason` reais é prosa
 * livre, e casar "Rage" ou "Aid" dentro de uma frase qualquer concederia efeito
 * por acidente. Aqui, diferente de um predicado, o falso positivo CUSTA — ele
 * fabrica um bônus em vez de apenas deixar de decidir.
 */
function triggerIndex(): { name: string; rec: RuleRecord }[] {
  if (triggers) return triggers;
  const out: { name: string; rec: RuleRecord }[] = [];
  for (const category of ["actions", "feats"] as const) {
    for (const rec of categoryRecords(category)) {
      if (rec.name.length < 6 || !/^[A-Za-z' -]+$/.test(rec.name)) continue;
      if (!selfEffectOf(rec)) continue;
      out.push({ name: rec.name, rec });
    }
  }
  // Mais longo primeiro: "Cobra Stance" antes de "Cobra".
  triggers = out.sort((a, b) => b.name.length - a.name.length);
  return triggers;
}

/**
 * O efeito auto-dirigido citado em prosa livre, ou `null`. Casa por palavra
 * inteira, preferindo o nome mais longo — mesma técnica de `mentionedAction`.
 *
 * `owned` é o portão que importa: só dispara o que a FICHA tem. É a mesma regra
 * que já rejeita cura e item sem fonte (doutrina 4), e é ela que torna seguro
 * ter "Flight" e "Passion" no índice — palavras comuns em prosa, mas inertes
 * para quem não tem o feat. Sem o portão, "he fights with passion" viraria
 * bônus.
 */
export function mentionedSelfEffect(
  text: string,
  owned: Iterable<string>,
): ResolvedEffect | null {
  const have = new Set([...owned].map((n) => n.toLowerCase().trim()));
  if (have.size === 0) return null;
  const t = text.toLowerCase();
  for (const { name, rec } of triggerIndex()) {
    if (!have.has(name.toLowerCase())) continue;
    const escaped = name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`).test(t)) return selfEffectOf(rec);
  }
  return null;
}

/** Só para teste: força a releitura dos índices. */
export function resetEffectIndex(): void {
  homonyms = null;
  triggers = null;
}

/** Como o efeito aparece no resumo mecânico: "Heroism (10 minutes)". */
export function effectLabel(e: ActiveEffect): string {
  const dur =
    e.unit === "unlimited"
      ? "no set duration"
      : e.unit === "encounter"
        ? "this encounter"
        : `${e.value} ${e.value === 1 ? e.unit.replace(/s$/, "") : e.unit}`;
  return `${e.name.replace(NAME_PREFIX, "")} (${dur})`;
}
