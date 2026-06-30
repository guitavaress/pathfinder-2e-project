import type { CheckResult, DegreeOfSuccess } from "@pf2e/shared";
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

/** Extracts the skill from the label "reason (skill vs DC n)" for the medallion. */
function extractSkill(label: string): string | null {
  const m = label.match(/\(([^)]+?) vs DC/i);
  return m ? skillLabel(m[1]!.trim()) : null;
}

export function RollMedallion({ result }: { result: CheckResult }) {
  const color = DEGREE_COLOR[result.degree];
  const skill = extractSkill(result.label);
  const title = `d20 ${result.die} ${fmt(result.modifier)} = ${result.total} vs DC ${result.dc} — ${DEGREE_LABEL[result.degree]}`;

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
