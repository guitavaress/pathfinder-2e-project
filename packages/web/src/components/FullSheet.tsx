import { useEffect } from "react";
import {
  ABILITIES,
  SKILL_NAMES,
  type Character,
  type GameState,
  type Skill,
} from "@pf2e/shared";
import { fmt, initials } from "../format.js";
import { ABILITY_LABEL, skillLabel } from "../labels.js";

interface Props {
  character: Character;
  state: GameState;
  onClose: () => void;
}

const DMG_LABEL: Record<string, string> = {
  P: "piercing",
  S: "slashing",
  B: "bludgeoning",
};

function ProfDots({ rank }: { rank: number }) {
  return (
    <span className="dots">
      {[0, 1, 2, 3].map((i) => (
        <span key={i} style={{ color: i < rank ? "var(--dot-on)" : "var(--dot-off)" }}>
          {i < rank ? "●" : "○"}
        </span>
      ))}
    </span>
  );
}

export function FullSheet({ character: c, state, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const trained: Skill[] = [];
  const untrained: Skill[] = [];
  for (const name of SKILL_NAMES) {
    const s = c.skills[name];
    if (s) (s.rank > 0 ? trained : untrained).push(s);
  }

  const sub = [
    c.heritage ? `${c.ancestry} (${c.heritage})` : c.ancestry,
    `${c.className} ${c.level}`,
    c.background,
    c.alignment ?? null,
    c.size ?? null,
  ]
    .filter(Boolean)
    .join(" · ");

  const sub2 = [
    c.languages.length ? `Languages: ${c.languages.join(", ")}` : null,
    c.senses.length ? `Senses: ${c.senses.join(", ")}` : null,
    `Class DC ${c.classDc}`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={`${c.name}'s sheet`}>
        <div className="fs-header">
          <div
            className="avatar avatar-lg"
            style={{ width: 108, height: 108, borderRadius: 10, fontSize: 40 }}
          >
            {initials(c.name)}
          </div>
          <div className="grow">
            <h2 className="fs-name">{c.name}</h2>
            <div className="fs-sub">{sub}</div>
            <div className="fs-sub2">{sub2}</div>
          </div>
          <div className="fs-cards">
            <div className="fs-card">
              <div className="n" style={{ color: "var(--hp-bright)" }}>
                {state.currentHp}/{c.maxHp}
              </div>
              <div className="vital-label">HP</div>
            </div>
            <div className="fs-card">
              <div className="n" style={{ color: "var(--gold-bright)" }}>
                {c.ac}
              </div>
              <div className="vital-label">AC</div>
            </div>
            <div className="fs-card">
              <div className="n" style={{ color: "var(--ink)" }}>
                {c.speed}
              </div>
              <div className="vital-label">Speed</div>
            </div>
          </div>
          <button className="fs-close" onClick={onClose} aria-label="Close sheet">
            ✕
          </button>
        </div>

        <div className="fs-body">
          {/* Left column */}
          <div className="fs-col">
            <div className="fs-section">Abilities</div>
            <div className="fs-attr-grid">
              {ABILITIES.map((a) => (
                <div key={a} className="fs-attr">
                  <div className="attr-label">{ABILITY_LABEL[a]}</div>
                  <div className="n">{fmt(c.abilityModifiers[a])}</div>
                  <div className="raw">{c.abilities[a]}</div>
                </div>
              ))}
            </div>

            <div className="fs-section">Saves</div>
            <div className="fs-attr-grid">
              <SaveTile label="Fortitude" v={c.saves.fortitude} />
              <SaveTile label="Reflex" v={c.saves.reflex} />
              <SaveTile label="Will" v={c.saves.will} />
            </div>

            <div className="fs-section">Skills</div>
            {trained.map((s) => (
              <SkillRow key={s.name} skill={s} />
            ))}
            {c.lores.map((l) => (
              <div key={l.name} className="fs-skill">
                <span className="nm">
                  {l.name} <span className="ab">lore</span>
                </span>
                <ProfDots rank={l.rank} />
                <span className="v">{fmt(l.modifier)}</span>
              </div>
            ))}
            {untrained.map((s) => (
              <SkillRow key={s.name} skill={s} untrained />
            ))}
          </div>

          {/* Right column */}
          <div className="fs-col">
            <div className="fs-section">Attacks</div>
            {c.weapons.length > 0 ? (
              c.weapons.map((w, i) => (
                <div key={`${w.name}-${i}`} className="fs-attack">
                  {w.name} {fmt(w.attack)} · {w.die}
                  {w.damageBonus ? fmt(w.damageBonus) : ""}{" "}
                  {DMG_LABEL[w.damageType] ?? w.damageType}
                </div>
              ))
            ) : (
              <div className="fs-text">—</div>
            )}
            {c.classFeatures.includes("Sneak Attack") && (
              <div className="fs-attack" style={{ color: "var(--muted-2)" }}>
                Sneak Attack +2d6 vs off-guard
              </div>
            )}

            {c.armor.length > 0 && (
              <>
                <div className="fs-section">Defenses</div>
                <div className="chips">
                  {c.armor.map((a, i) => (
                    <span key={`${a.name}-${i}`} className="chip">
                      {a.name}
                      {a.worn ? " (worn)" : ""}
                    </span>
                  ))}
                </div>
              </>
            )}

            {c.classFeatures.length > 0 && (
              <>
                <div className="fs-section">Class features</div>
                <div className="chips">
                  {c.classFeatures.map((f) => (
                    <span key={f} className="chip">
                      {f}
                    </span>
                  ))}
                </div>
              </>
            )}

            {c.feats.length > 0 && (
              <>
                <div className="fs-section">Feats</div>
                <div className="fs-text">{c.feats.join(" · ")}</div>
              </>
            )}

            <div className="fs-section">Equipment</div>
            <div className="fs-text">
              {c.equipment.length > 0
                ? c.equipment.map((e) => (e.qty > 1 ? `${e.name} ×${e.qty}` : e.name)).join(" · ")
                : "—"}
            </div>
            <div className="chips" style={{ marginTop: 8 }}>
              {c.money.pp > 0 && <span className="chip">{c.money.pp} pp</span>}
              {c.money.gp > 0 && <span className="chip">{c.money.gp} gp</span>}
              {c.money.sp > 0 && <span className="chip">{c.money.sp} sp</span>}
              {c.money.cp > 0 && <span className="chip">{c.money.cp} cp</span>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SaveTile({ label, v }: { label: string; v: number }) {
  return (
    <div className="fs-attr">
      <div className="attr-label">{label}</div>
      <div className="n">{fmt(v)}</div>
    </div>
  );
}

function SkillRow({ skill: s, untrained }: { skill: Skill; untrained?: boolean }) {
  return (
    <div className={`fs-skill${untrained ? " untrained" : ""}`}>
      <span className="nm">
        {skillLabel(s.name)} <span className="ab">{ABILITY_LABEL[s.ability]}</span>
      </span>
      <ProfDots rank={s.rank} />
      <span className="v">{fmt(s.modifier)}</span>
    </div>
  );
}
