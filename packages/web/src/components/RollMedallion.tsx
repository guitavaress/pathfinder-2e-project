import type { AttackContext, CheckResult, DegreeOfSuccess } from "@pf2e/shared";
import { fmt } from "../format.js";
import { skillLabel } from "../labels.js";

const DEGREE_LABEL: Record<DegreeOfSuccess, string> = {
  criticalSuccess: "critical success",
  success: "success",
  failure: "failure",
  criticalFailure: "critical failure",
};

const DEGREE_COLOR: Record<DegreeOfSuccess, string> = {
  criticalSuccess: "#a9c47e",
  success: "#84a05c",
  failure: "#c2853f",
  criticalFailure: "#9e3b34",
};

const OUTCOME_LABEL: Record<AttackContext["outcome"], string> = {
  criticalHit: "critical hit",
  hit: "hit",
  miss: "miss",
  criticalMiss: "critical miss",
};

/** Extracts the skill/weapon from the label "reason (skill vs DC|AC n)". */
function extractSkill(label: string): string | null {
  const m = label.match(/\(([^)]+?) vs (?:DC|AC)/i);
  return m ? skillLabel(m[1]!.trim()) : null;
}

export function RollMedallion({ result }: { result: CheckResult }) {
  const color = DEGREE_COLOR[result.degree];
  const atk = result.attack;
  const vsLabel = atk ? "AC" : "DC";
  const title = `d20 ${result.die} ${fmt(result.modifier)} = ${result.total} vs ${vsLabel} ${result.dc} — ${DEGREE_LABEL[result.degree]}`;

  // Attack Strike: show attacker → target, outcome, and damage. Enemy attacks
  // get a red accent so it's obvious the PLAYER took the hit.
  if (atk) {
    const enemyAttack = atk.attackerKind === "enemy";
    const dmg =
      atk.damage != null
        ? ` · ${atk.damage}${atk.damageType ? ` ${atk.damageType}` : ""}`
        : "";
    return (
      <span
        className={`medallion${enemyAttack ? " incoming" : ""}`}
        style={{ borderColor: enemyAttack ? "var(--hp)" : color }}
        title={title}
      >
        <span className="medallion-disc" style={{ color }}>
          {result.total}
        </span>
        <span className="medallion-atk">
          <span className="medallion-who">
            {atk.attacker} <span className="medallion-arrow">→</span> {atk.target}
          </span>
          <span className="medallion-out" style={{ color }}>
            {OUTCOME_LABEL[atk.outcome]}
            {dmg}
          </span>
        </span>
      </span>
    );
  }

  // Plain check (skill / save / Perception).
  const skill = extractSkill(result.label);
  return (
    <span className="medallion" style={{ borderColor: color }} title={title}>
      <span className="medallion-disc" style={{ color }}>
        {result.total}
      </span>
      <span className="medallion-label" style={{ color }}>
        {skill ? `${skill} · ` : ""}
        {DEGREE_LABEL[result.degree]}
      </span>
    </span>
  );
}
