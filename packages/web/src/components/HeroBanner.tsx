import type { ReactNode } from "react";
import type { Character, GameState } from "@pf2e/shared";
import { fmt, initials } from "../format.js";
import { BootIcon, EyeIcon, HeartIcon, ShieldIcon } from "./icons.js";

interface Props {
  character: Character;
  state: GameState;
}

export function HeroBanner({ character: c, state }: Props) {
  const hpPct = c.maxHp > 0 ? Math.max(0, Math.min(100, (state.currentHp / c.maxHp) * 100)) : 0;
  const subtitle = [
    c.heritage ? `${c.ancestry} (${c.heritage})` : c.ancestry,
    c.className,
    c.background,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <header className="hero">
      <div className="hero-left">
        <div className="avatar" style={{ width: 84, height: 84, borderRadius: 8, fontSize: 30 }}>
          {initials(c.name)}
        </div>
        <div>
          <h1 className="hero-name">
            {c.name} <span className="hero-level">· LEVEL {c.level}</span>
          </h1>
          <div className="hero-sub">{subtitle}</div>
        </div>
      </div>

      <div className="hero-vitals">
        <div className="vital hp">
          <div className="vital-top">
            <HeartIcon size={14} style={{ color: "var(--hp-bright)" }} />
            <span className="vital-num">
              {state.currentHp}
              <span style={{ color: "var(--faint)", fontSize: 13 }}>/{c.maxHp}</span>
            </span>
          </div>
          <div className="vital-label">Hit Points</div>
          <div className="hpbar">
            <div className="hpbar-fill" style={{ width: `${hpPct}%` }} />
          </div>
        </div>

        <Vital icon={<ShieldIcon size={14} style={{ color: "var(--gold)" }} />} num={String(c.ac)} label="AC" />
        <Vital
          icon={<EyeIcon size={14} style={{ color: "var(--gold)" }} />}
          num={fmt(c.perception)}
          label="Perc"
        />
        <Vital
          icon={<BootIcon size={14} style={{ color: "var(--gold)" }} />}
          num={String(c.speed)}
          label="Speed"
        />
      </div>
    </header>
  );
}

function Vital({ icon, num, label }: { icon: ReactNode; num: string; label: string }) {
  return (
    <div className="vital">
      <div className="vital-top">
        {icon}
        <span className="vital-num">{num}</span>
      </div>
      <div className="vital-label">{label}</div>
    </div>
  );
}
