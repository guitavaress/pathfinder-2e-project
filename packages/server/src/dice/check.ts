import type { CheckResult, DegreeOfSuccess } from "@pf2e/shared";

/** Rolls a d20 (1–20). Overridable in tests by injecting `rng`. */
export function rollD20(rng: () => number = Math.random): number {
  return Math.floor(rng() * 20) + 1;
}

/**
 * Computes the PF2e degree of success.
 *
 * Base rule (margin of 10):
 *  - total >= DC + 10 → critical success
 *  - total >= DC      → success
 *  - total <= DC - 10 → critical failure
 *  - otherwise        → failure
 *
 * Natural d20 adjustment: a natural 20 bumps one degree up; a natural 1 bumps one degree down.
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

/** Runs a full roll: d20 + modifier against the DC. */
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
