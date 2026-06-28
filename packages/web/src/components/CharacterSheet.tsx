import type { Character, GameState } from "@pf2e/shared";

const fmt = (n: number) => (n >= 0 ? `+${n}` : `${n}`);

interface Props {
  character: Character;
  state: GameState;
}

export function CharacterSheet({ character: c, state }: Props) {
  return (
    <aside className="sheet">
      <h2>{c.name}</h2>
      <p className="subtitle">
        {c.ancestry}
        {c.heritage ? ` (${c.heritage})` : ""} {c.className} nível {c.level}
        <br />
        {c.background}
      </p>

      <div className="vitals">
        <span>
          HP <strong>{state.currentHp}</strong>/{c.maxHp}
        </span>
        <span>
          CA <strong>{c.ac}</strong>
        </span>
        <span>
          Perc <strong>{fmt(c.perception)}</strong>
        </span>
        <span>
          Desl <strong>{c.speed}</strong>
        </span>
      </div>

      {state.conditions.length > 0 && (
        <p className="conditions">Condições: {state.conditions.join(", ")}</p>
      )}

      <h3>Atributos</h3>
      <div className="abilities">
        {Object.entries(c.abilityModifiers).map(([a, m]) => (
          <span key={a}>
            {a.toUpperCase()} {fmt(m)}
          </span>
        ))}
      </div>

      <h3>Saves</h3>
      <div className="abilities">
        <span>Fort {fmt(c.saves.fortitude)}</span>
        <span>Ref {fmt(c.saves.reflex)}</span>
        <span>Will {fmt(c.saves.will)}</span>
      </div>

      <h3>Perícias</h3>
      <ul className="skills">
        {Object.values(c.skills)
          .filter((s) => s.rank > 0)
          .map((s) => (
            <li key={s.name}>
              {s.name} {fmt(s.modifier)}
            </li>
          ))}
        {c.lores.map((l) => (
          <li key={l.name}>
            {l.name} (Lore) {fmt(l.modifier)}
          </li>
        ))}
      </ul>

      {c.weapons.length > 0 && (
        <>
          <h3>Ataques</h3>
          <ul className="skills">
            {c.weapons.map((w, i) => (
              <li key={`${w.name}-${i}`}>
                {w.name} {fmt(w.attack)} · {w.die}
                {w.damageBonus ? fmt(w.damageBonus) : ""} {w.damageType}
              </li>
            ))}
          </ul>
        </>
      )}

      {c.armor.length > 0 && (
        <>
          <h3>Defesas</h3>
          <div className="abilities">
            {c.armor.map((a, i) => (
              <span key={`${a.name}-${i}`}>
                {a.name}
                {a.worn ? " (equipada)" : ""}
              </span>
            ))}
          </div>
        </>
      )}

      {c.classFeatures.length > 0 && (
        <>
          <h3>Traços de classe</h3>
          <p className="featlist">{c.classFeatures.join(", ")}</p>
        </>
      )}

      {c.feats.length > 0 && (
        <>
          <h3>Talentos</h3>
          <p className="featlist">{c.feats.join(", ")}</p>
        </>
      )}

      {c.spellcasting.length > 0 && (
        <>
          <h3>Magias</h3>
          {c.spellcasting.map((sc, i) => (
            <div key={`${sc.name}-${i}`} className="spellcasting">
              <span className="subtitle">
                {sc.tradition} ({sc.type})
                {sc.dc != null ? ` · DC ${sc.dc}` : ""}
                {sc.attack != null ? ` · atk ${fmt(sc.attack)}` : ""}
              </span>
              {sc.spells.length > 0 && <p className="featlist">{sc.spells.join(", ")}</p>}
            </div>
          ))}
        </>
      )}

      {c.equipment.length > 0 && (
        <>
          <h3>Equipamento</h3>
          <p className="featlist">
            {c.equipment
              .map((e) => (e.qty > 1 ? `${e.name} ×${e.qty}` : e.name))
              .join(", ")}
          </p>
        </>
      )}

      <h3>Dinheiro</h3>
      <div className="abilities">
        {c.money.pp > 0 && <span>{c.money.pp} pp</span>}
        {c.money.gp > 0 && <span>{c.money.gp} gp</span>}
        {c.money.sp > 0 && <span>{c.money.sp} sp</span>}
        {c.money.cp > 0 && <span>{c.money.cp} cp</span>}
      </div>
    </aside>
  );
}
