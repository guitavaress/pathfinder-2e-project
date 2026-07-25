/**
 * Consumidor PILOTO de rule elements (Fase 1.5, ADR-007): os FlatModifier das
 * condições, lidos do dado oficial.
 *
 * O que ele é: o molde de todo consumidor futuro — lê `rules` verbatim do
 * dataset e expõe uma vista estruturada e testável.
 *
 * O que ele NÃO é: a engine não muda de fonte. `effectiveAC`/
 * `attackStatusPenalty` continuam determinísticos em código (Régua). O piloto
 * é o ALARME: o teste de conformidade compara as constantes da engine com o
 * dado — se um bump de ref mudar um modificador oficial, o teste quebra ANTES
 * de a divergência virar bug de jogo silencioso.
 */
import { lookupLocalRule } from "./dataset.js";

/** Um FlatModifier de condição, na forma que interessa à engine. */
export interface ConditionModifier {
  /** A que se aplica: "ac", "all", "attack"… (selector do rule element). */
  selector: string;
  /** Tipo PF2e do modificador: "circumstance" | "status" | "item". */
  type: string;
  /**
   * Valor fixo (ex.: -2) ou null quando é dirigido pelo VALOR da condição
   * ("-@item.badge.value" — frightened N aplica -N).
   */
  value: number | null;
  /** true quando o valor escala com o valor da condição (badge). */
  scalesWithValue: boolean;
}

/** FlatModifiers da condição nomeada, lidos do dataset (ordem do documento). */
export function conditionModifiers(name: string): ConditionModifier[] {
  const rec = lookupLocalRule(name);
  if (!rec || rec.category !== "conditions" || !Array.isArray(rec.rules)) return [];
  const out: ConditionModifier[] = [];
  for (const raw of rec.rules) {
    const r = raw as Record<string, unknown>;
    if (r.key !== "FlatModifier") continue;
    const selector = typeof r.selector === "string" ? r.selector : "";
    const type = typeof r.type === "string" ? r.type : "";
    if (!selector) continue;
    const scales =
      typeof r.value === "string" && r.value.includes("@item.badge.value");
    out.push({
      selector,
      type,
      value: typeof r.value === "number" ? r.value : null,
      scalesWithValue: scales,
    });
  }
  return out;
}
