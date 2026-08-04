/**
 * As condições da engine, lidas do DADO oficial (Fase 2.5 / T4).
 *
 * Era o piloto de consumo de rule elements (Fase 1.5, ADR-007) e servia só de
 * ALARME: o teste comparava as constantes hard-coded de `combat.ts` com o dado
 * e quebrava se divergissem. Agora o alarme é desnecessário por construção —
 * a engine LÊ daqui. Off-guard, frightened e as demais condições com
 * `FlatModifier` deixam de ter valor escrito à mão.
 *
 * Este módulo é impuro (carrega o dataset). Quem o liga em `combat.ts` é
 * `agent.ts`, via `setConditionModifierSource` — um ponto de injeção só.
 */
import { conditionRecords } from "./dataset.js";
import { evaluate } from "./predicate.js";
import { modifierType, type Modifier } from "./modifiers.js";
import type { RollOptions } from "./roll-options.js";

/** Um FlatModifier de condição, na forma crua que o dado traz. */
export interface ConditionModifier {
  slug: string;
  /** Sempre lista: o dado usa string ou array (`["ac","saving-throw"]`). */
  selectors: string[];
  /** "circumstance" | "status" | "item" | "untyped". */
  type: string;
  /** Valor fixo, ou null quando depende do valor da condição / não resolvido. */
  value: number | null;
  /** true quando escala com o valor da condição ("-@item.badge.value"). */
  scalesWithValue: boolean;
  /** Sinal com que escala: −1 em "-@item.badge.value", +1 em "@item.badge.value". */
  scaleSign?: -1 | 1;
  /** Expressão crua que NÃO soubemos resolver — declarada, nunca aplicada. */
  unresolved?: string;
  predicate?: unknown;
}

let byName: Map<string, ConditionModifier[]> | null = null;

/** Índice EXATO da categoria `conditions` — sem fuzzy: "prone" não pode cair
 *  num feat de nome parecido. */
function index(): Map<string, ConditionModifier[]> {
  if (byName) return byName;
  byName = new Map();
  for (const rec of conditionRecords()) {
    if (!Array.isArray(rec.rules)) continue;
    const mods: ConditionModifier[] = [];
    for (const raw of rec.rules) {
      const r = raw as Record<string, unknown>;
      if (r.key !== "FlatModifier") continue;
      const selectors = Array.isArray(r.selector)
        ? r.selector.filter((s): s is string => typeof s === "string")
        : typeof r.selector === "string"
          ? [r.selector]
          : [];
      if (selectors.length === 0) continue;
      mods.push({
        slug: typeof r.slug === "string" ? r.slug : rec.name.toLowerCase(),
        selectors,
        type: typeof r.type === "string" ? r.type : "",
        ...resolveValue(r.value),
        ...(r.predicate === undefined ? {} : { predicate: r.predicate }),
      });
    }
    byName.set(rec.name.toLowerCase(), mods);
  }
  return byName;
}

/**
 * Resolve a expressão de valor do rule element. As formas que aparecem em
 * `conditions.json` são poucas e explícitas; qualquer outra fica DECLARADA em
 * `unresolved` e não é aplicada — inventar um número aqui seria pior que não
 * aplicar (ex.: o `hp` do Drained é `min(-1 * @actor.level,-1) * badge`).
 */
function resolveValue(raw: unknown): Pick<
  ConditionModifier,
  "value" | "scalesWithValue" | "scaleSign" | "unresolved"
> {
  if (typeof raw === "number") return { value: raw, scalesWithValue: false };
  if (typeof raw !== "string") return { value: null, scalesWithValue: false };
  const expr = raw.replace(/\s+/g, "");
  if (expr === "-@item.badge.value" || expr === "-1*@item.badge.value") {
    return { value: null, scalesWithValue: true, scaleSign: -1 };
  }
  if (expr === "@item.badge.value" || expr === "1*@item.badge.value") {
    return { value: null, scalesWithValue: true, scaleSign: 1 };
  }
  return { value: null, scalesWithValue: false, unresolved: raw };
}

/** FlatModifiers da condição nomeada, como estão no dado. */
export function conditionModifiers(name: string): ConditionModifier[] {
  return index().get(name.toLowerCase().trim()) ?? [];
}

/** Separa "frightened 2" em nome e valor (sem número = 1, como em PF2e). */
export function splitConditionName(raw: string): { name: string; value: number } {
  const m = /^(.*?)(?:\s+(\d+))?$/.exec(raw.trim().toLowerCase());
  return { name: (m?.[1] ?? raw).trim(), value: m?.[2] ? Number(m[2]) : 1 };
}

/**
 * Os modificadores que as condições de um combatente aplicam sobre um seletor.
 *
 * `all` no dado significa "toda checagem e DC" — cobre tanto a CA do alvo
 * quanto a rolagem de ataque do atacante.
 *
 * `selector` é string livre e não a união estreita da engine porque o dado usa
 * ~40 seletores (`saving-throw`, `perception`, `athletics`, `fortitude`…) e
 * fechar o tipo aqui obrigaria a reescrever a assinatura a cada seletor novo —
 * quem restringe é o chamador (`conditionStack` em `combat.ts`).
 *
 * Predicado presente e não seguramente verdadeiro NÃO aplica: sem contexto de
 * rolagem (`ro`), um `FlatModifier` condicional fica de fora em vez de entrar
 * por omissão. É a mesma regra da T3 — indecidível não é permissão.
 */
export function conditionModifiersFor(
  conditions: string[],
  selector: string,
  ro?: RollOptions,
): Modifier[] {
  const out: Modifier[] = [];
  for (const raw of conditions) {
    const { name, value } = splitConditionName(raw);
    if (!name) continue;
    for (const mod of conditionModifiers(name)) {
      if (!mod.selectors.includes(selector) && !mod.selectors.includes("all")) continue;
      if (mod.predicate !== undefined) {
        if (!ro || evaluate(mod.predicate, ro).value !== "true") continue;
      }
      const amount = mod.scalesWithValue
        ? (mod.scaleSign ?? -1) * value
        : mod.value !== null
          ? mod.value
          : null;
      if (amount === null || amount === 0) continue;
      out.push({
        slug: mod.slug,
        type: modifierType(mod.type),
        value: amount,
        source: name,
      });
    }
  }
  return out;
}
