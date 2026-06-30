import { ABILITIES, type Character, type GameState } from "@pf2e/shared";
import { fmt } from "../format.js";
import { ABILITY_LABEL, skillLabel } from "../labels.js";
import { ScrollIcon } from "./icons.js";

interface Props {
  character: Character;
  state: GameState;
  onOpenSheet: () => void;
}

export function CompactRail({ character: c, state, onOpenSheet }: Props) {
  // "Key" = ability/abilities with the highest modifier (proxy for key ability).
  const maxMod = Math.max(...ABILITIES.map((a) => c.abilityModifiers[a]));
  const topSkills = Object.values(c.skills)
    .sort((a, b) => b.modifier - a.modifier)
    .slice(0, 4);

  return (
    <aside className="rail">
      <div className="rail-h">On scene</div>
      <div className="cond-row">
        {state.conditions.length > 0 ? (
          state.conditions.map((cond) => (
            <span key={cond} className="cond-chip">
              {cond}
            </span>
          ))
        ) : (
          <span className="cond-empty">No conditions.</span>
        )}
      </div>

      <div className="rail-h">Abilities</div>
      <div className="attr-grid">
        {ABILITIES.map((a) => (
          <div
            key={a}
            className={`attr-tile${c.abilityModifiers[a] === maxMod ? " key" : ""}`}
          >
            <div className="attr-label">{ABILITY_LABEL[a]}</div>
            <div className="attr-num">{fmt(c.abilityModifiers[a])}</div>
          </div>
        ))}
      </div>

      <div className="rail-h">Top skills</div>
      {topSkills.map((s) => (
        <div key={s.name} className="skill-line">
          <span>{skillLabel(s.name)}</span>
          <span className="v">{fmt(s.modifier)}</span>
        </div>
      ))}

      <button className="rail-btn" onClick={onOpenSheet}>
        <ScrollIcon size={15} />
        Full sheet
      </button>
    </aside>
  );
}
