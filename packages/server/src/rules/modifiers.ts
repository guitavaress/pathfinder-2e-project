/**
 * Pilha de modificadores do PF2e.
 *
 * A regra que a aritmética ingênua erra: modificadores do MESMO tipo não se
 * somam. De cada tipo (circunstância, status, item) vale só o **maior bônus** e
 * a **pior penalidade**; sem tipo (untyped) tudo soma. Um alvo off-guard
 * (circunstância −2) e frightened 2 (status −2) leva −4; frightened 2 e
 * sickened 3 (ambos status) leva −3, não −5.
 *
 * Módulo PURO — sem dataset em runtime, para que `gm/combat.ts` possa importá-lo
 * (mesmo contrato de `damage.ts`). Quem lê o dado é `condition-modifiers.ts`.
 */

/**
 * Tipos de modificador que empilham por categoria; `untyped` sempre soma.
 *
 * `ability` e `proficiency` são poucos no dado (12 rule elements), mas entram
 * como tipos PRÓPRIOS de propósito: dobrados em `untyped` eles passariam a
 * somar entre si, que é justamente o erro que esta pilha existe para evitar.
 */
export const MODIFIER_TYPES = [
  "circumstance",
  "status",
  "item",
  "ability",
  "proficiency",
  "untyped",
] as const;
export type ModifierType = (typeof MODIFIER_TYPES)[number];

export interface Modifier {
  /** Origem canônica ("off-guard", "frightened") — o slug do rule element. */
  slug: string;
  type: ModifierType;
  /** Positivo = bônus, negativo = penalidade. */
  value: number;
  /** Rótulo humano para o resumo mecânico (default: o slug). */
  source?: string;
}

/** Normaliza o `type` cru do rule element (ausente/desconhecido = untyped). */
export function modifierType(raw: unknown): ModifierType {
  const s = String(raw ?? "").toLowerCase().trim();
  return (MODIFIER_TYPES as readonly string[]).includes(s) ? (s as ModifierType) : "untyped";
}

/**
 * Aplica o empilhamento RAW e devolve quais modificadores realmente contam.
 * O que NÃO conta sai em `suppressed` — a pilha explica o número, não só o
 * produz (é o que permite o resumo mecânico dizer por que a CA é aquela).
 */
export class ModifierStack {
  private readonly mods: Modifier[] = [];

  add(mod: Modifier): this {
    if (Number.isFinite(mod.value) && mod.value !== 0) this.mods.push(mod);
    return this;
  }

  addAll(mods: Iterable<Modifier>): this {
    for (const m of mods) this.add(m);
    return this;
  }

  /** Os modificadores que sobrevivem ao empilhamento. */
  applied(): Modifier[] {
    const out: Modifier[] = [];
    const bestBonus = new Map<ModifierType, Modifier>();
    const worstPenalty = new Map<ModifierType, Modifier>();
    for (const m of this.mods) {
      if (m.type === "untyped") {
        out.push(m); // untyped soma sempre
        continue;
      }
      const bucket = m.value > 0 ? bestBonus : worstPenalty;
      const cur = bucket.get(m.type);
      // Empate mantém o PRIMEIRO: a ordem do documento decide, sem sorteio.
      if (!cur || (m.value > 0 ? m.value > cur.value : m.value < cur.value)) {
        bucket.set(m.type, m);
      }
    }
    return [...out, ...bestBonus.values(), ...worstPenalty.values()];
  }

  /** Os que foram descartados por já haver outro do mesmo tipo mais forte. */
  suppressed(): Modifier[] {
    const kept = new Set(this.applied());
    return this.mods.filter((m) => !kept.has(m));
  }

  total(): number {
    const sum = this.applied().reduce((s, m) => s + m.value, 0);
    return sum === 0 ? 0 : sum; // evita -0
  }

  /** "-2 circumstance (off-guard), -2 status (frightened)" para o resumo. */
  breakdown(): string {
    return this.applied()
      .map((m) => `${m.value > 0 ? "+" : ""}${m.value} ${m.type} (${m.source ?? m.slug})`)
      .join(", ");
  }
}

/** Atalho para quem só quer o número. */
export function stackTotal(mods: Iterable<Modifier>): number {
  return new ModifierStack().addAll(mods).total();
}
