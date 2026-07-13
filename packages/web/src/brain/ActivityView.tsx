/**
 * Tab Atividade (frame 1E): auditoria do write pass, 1 card por pass —
 * aplicados como chips verdes (+/~/»), rejeitados em âmbar com o motivo
 * (nunca vermelho — não é erro do jogador), erro de sistema em vermelho.
 * A borda do card acompanha o pior estado.
 */
import { humanStamp, type BrainActivityPass } from "./api.js";

const VERB: Record<string, string> = { CREATE: "+", UPDATE: "~", APPEND: "»" };

function appliedChip(cmd: string): { verb: string; target: string } {
  const m = /^(CREATE|UPDATE|APPEND)\s+(.+)\.md$/.exec(cmd);
  if (m) return { verb: VERB[m[1]!] ?? "·", target: m[2]! };
  if (cmd === "TIMELINE") return { verb: "»", target: "Timeline" };
  if (cmd === "JOURNAL") return { verb: "»", target: "Journal" };
  return { verb: "·", target: cmd };
}

export function ActivityView({ activity }: { activity: BrainActivityPass[] }) {
  if (activity.length === 0) {
    return (
      <div className="brain-center">
        <p className="brain-soft-italic">
          Nenhum write pass ainda nesta sessão do servidor. Jogue um turno — o
          escriba anota logo depois da narração.
        </p>
      </div>
    );
  }

  return (
    <div className="brain-activity">
      <p className="brain-activity-lead">
        Depois de cada turno, o escriba relê a cena e grava o que o protagonista
        aprendeu. Cada passe abaixo lista o que foi salvo — e o que foi
        rejeitado, com o motivo.
      </p>
      <div className="brain-activity-list">
        {activity.map((pass, i) => {
          const hasError = !!pass.error;
          const hasRejected = pass.rejected.length > 0;
          const border = hasError ? "#6e342f" : hasRejected ? "#6e5326" : "#322820";
          const summary = hasError
            ? "falhou"
            : `${pass.applied.length} aplicados${hasRejected ? ` · ${pass.rejected.length} rejeitado${pass.rejected.length > 1 ? "s" : ""}` : ""}`;
          const summaryColor = hasError ? "#d98a82" : hasRejected ? "#c2853f" : "#8a7a5e";
          return (
            <div key={i} className="brain-pass" style={{ borderColor: border }}>
              <div className="brain-pass-head">
                <span className="brain-pass-stamp">{humanStamp(pass.stamp)}</span>
                <span className="brain-pass-kind">write pass</span>
                <div className="brain-topbar-spring" />
                <span className="brain-pass-summary" style={{ color: summaryColor }}>
                  {summary}
                </span>
              </div>
              {pass.applied.length > 0 && (
                <div className="brain-pass-applied">
                  {pass.applied.map((cmd, j) => {
                    const chip = appliedChip(cmd);
                    return (
                      <span key={j} className="brain-pass-chip">
                        <span className="verb">{chip.verb}</span>
                        {chip.target}
                      </span>
                    );
                  })}
                </div>
              )}
              {hasRejected && (
                <div className="brain-pass-rejects">
                  {pass.rejected.map((rej, j) => (
                    <div key={j} className="brain-pass-reject">
                      <span className="tag">✕ REJEITADO</span>
                      <span className="cmd">{rej.command}</span>
                      <span className="why">— {rej.reason}</span>
                    </div>
                  ))}
                </div>
              )}
              {hasError && (
                <div className="brain-pass-error">
                  <span className="tag">! ERRO</span>
                  <span>{pass.error}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
