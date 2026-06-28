import type { CheckResult, DegreeOfSuccess } from "@pf2e/shared";

/** Rola um d20 (1–20). Substituível em testes injetando `roll`. */
export function rollD20(rng: () => number = Math.random): number {
  return Math.floor(rng() * 20) + 1;
}

/**
 * Calcula o grau de sucesso de PF2e.
 *
 * Regra base (margem de 10):
 *  - total >= DC + 10 → sucesso crítico
 *  - total >= DC      → sucesso
 *  - total <= DC - 10 → falha crítica
 *  - caso contrário   → falha
 *
 * Ajuste do d20 natural: um 20 natural sobe um grau; um 1 natural desce um grau.
 */
export function degreeOfSuccess(
  die: number,
  total: number,
  dc: number,
): DegreeOfSuccess {
  let degree: DegreeOfSuccess;
  if (total >= dc + 10) degree = "criticalSuccess";
  else if (total >= dc) degree = "success";
  else if (total <= dc - 10) degree = "criticalFailure";
  else degree = "failure";

  if (die === 20) degree = bumpUp(degree);
  else if (die === 1) degree = bumpDown(degree);

  return degree;
}

const ORDER: DegreeOfSuccess[] = [
  "criticalFailure",
  "failure",
  "success",
  "criticalSuccess",
];

function bumpUp(d: DegreeOfSuccess): DegreeOfSuccess {
  const i = ORDER.indexOf(d);
  return ORDER[Math.min(i + 1, ORDER.length - 1)]!;
}

function bumpDown(d: DegreeOfSuccess): DegreeOfSuccess {
  const i = ORDER.indexOf(d);
  return ORDER[Math.max(i - 1, 0)]!;
}

/** Executa uma rolagem completa: d20 + modificador contra a DC. */
export function rollCheck(
  label: string,
  modifier: number,
  dc: number,
  rng: () => number = Math.random,
): CheckResult {
  const die = rollD20(rng);
  const total = die + modifier;
  return {
    label,
    die,
    modifier,
    total,
    dc,
    degree: degreeOfSuccess(die, total, dc),
  };
}
