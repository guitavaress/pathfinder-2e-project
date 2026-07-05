import type { Combat, Combatant } from "@pf2e/shared";

function hpPct(c: Combatant): number {
  return c.maxHp > 0 ? Math.max(0, Math.min(100, (c.currentHp / c.maxHp) * 100)) : 0;
}

/** MAP that applies to the player's NEXT Strike (standard, non-agile). */
function nextMapLabel(mapProgress: number): string {
  if (mapProgress <= 0) return "+0";
  if (mapProgress === 1) return "−5";
  return "−10";
}

/**
 * Live combat HUD (interim): round, initiative order with HP bars, and the
 * player's action economy. Rendered only while a fight is active. Reuses the
 * app's HP-bar and token styles; to be refined once Design delivers the comp.
 */
export function CombatPanel({ combat }: { combat: Combat }) {
  const player = combat.combatants.find((c) => c.kind === "player");

  return (
    <div className="combat-panel">
      <div className="combat-head">
        <span className="combat-title">Combat</span>
        <span className="combat-round">Round {combat.round}</span>
      </div>

      <div className="combatants">
        {combat.combatants.map((c) => (
          <div
            key={c.id}
            className={`combatant ${c.kind}${c.defeated ? " defeated" : ""}`}
          >
            <div className="combatant-top">
              <span className="combatant-name">{c.name}</span>
              <span className="combatant-meta">
                <span className="cb-init" title="Initiative">
                  i{c.initiative}
                </span>
                <span className="cb-ac" title="Armor Class">
                  AC {c.ac}
                </span>
              </span>
            </div>
            <div className="hpbar">
              <div className="hpbar-fill" style={{ width: `${hpPct(c)}%` }} />
            </div>
            <div className="combatant-foot">
              <span className="cb-hp">
                {c.defeated ? "defeated" : `${c.currentHp}/${c.maxHp} HP`}
              </span>
              {c.conditions.length > 0 && (
                <span className="cb-conds">
                  {c.conditions.map((cond) => (
                    <span key={cond} className="cond-chip sm">
                      {cond}
                    </span>
                  ))}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {player && !player.defeated && (
        <div className="action-econ">
          <span className="ae-label">Your turn</span>
          <span className="pips" title="Actions remaining">
            {[0, 1, 2].map((i) => (
              <span key={i} className={`pip${i < player.actionsRemaining ? " on" : ""}`} />
            ))}
          </span>
          <span
            className={`reaction${player.reactionAvailable ? " on" : ""}`}
            title="Reaction"
          >
            ↺
          </span>
          <span className="ae-map" title="Multiple Attack Penalty on your next Strike">
            MAP {nextMapLabel(player.mapProgress)}
          </span>
        </div>
      )}
    </div>
  );
}
