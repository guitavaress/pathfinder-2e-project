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
import { effectRecord, type RuleRecord } from "./dataset.js";
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
    else kept.push(e);
  }
  return { effects: kept, expired };
}

function isExpired(e: ActiveEffect, event: ExpiryEvent, round: number | null): boolean {
  if (e.unit === "unlimited") return false;
  switch (event) {
    case "round":
      return e.expiresOnRound !== null && round !== null && round >= e.expiresOnRound;
    case "combat-end":
      return e.unit === "encounter" || e.unit === "rounds" || e.unit === "minutes";
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
