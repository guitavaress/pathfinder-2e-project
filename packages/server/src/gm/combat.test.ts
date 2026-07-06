import { describe, expect, it } from "vitest";
import type { Combatant } from "@pf2e/shared";
import {
  advanceTurn,
  applyDamage,
  applyRecovery,
  attackStatusPenalty,
  beginPlayerRound,
  benchmark,
  buildCombat,
  clampActionCost,
  combatStatus,
  conditionValueIn,
  conditionValue,
  effectiveAC,
  findCombatant,
  hasCombatantNamed,
  isOffGuard,
  livingEnemy,
  mapPenalty,
  passiveFeatBonus,
  playerCombatant,
  setValuedCondition,
  tickEndOfRound,
} from "./combat.js";
import type { Character } from "@pf2e/shared";

/** Builds a bare combatant with overridable fields (deterministic — no RNG). */
function mkCombatant(partial: Partial<Combatant> & Pick<Combatant, "name" | "kind">): Combatant {
  return {
    id: partial.name.toLowerCase().replace(/\s+/g, "-"),
    initiative: 10,
    ac: 15,
    maxHp: 20,
    currentHp: 20,
    conditions: [],
    actionsRemaining: 0,
    reactionAvailable: true,
    mapProgress: 0,
    level: 1,
    traits: [],
    defeated: false,
    ...partial,
  };
}

describe("mapPenalty", () => {
  it("é 0 na 1ª Strike, -5 na 2ª, -10 na 3ª (não-agile)", () => {
    expect(mapPenalty(0)).toBe(0);
    expect(mapPenalty(1)).toBe(-5);
    expect(mapPenalty(2)).toBe(-10);
    expect(mapPenalty(3)).toBe(-10);
  });

  it("usa -4/-8 para armas agile", () => {
    expect(mapPenalty(0, true)).toBe(0);
    expect(mapPenalty(1, true)).toBe(-4);
    expect(mapPenalty(2, true)).toBe(-8);
  });
});

describe("applyDamage", () => {
  it("subtrai HP e clampa em 0, marcando derrota", () => {
    const c = mkCombatant({ name: "Sentinel", kind: "enemy", currentHp: 10 });
    applyDamage(c, 4);
    expect(c.currentHp).toBe(6);
    expect(c.defeated).toBe(false);
    applyDamage(c, 100);
    expect(c.currentHp).toBe(0);
    expect(c.defeated).toBe(true);
  });

  it("ignora dano negativo", () => {
    const c = mkCombatant({ name: "Sentinel", kind: "enemy", currentHp: 10 });
    applyDamage(c, -5);
    expect(c.currentHp).toBe(10);
  });
});

describe("buildCombat", () => {
  it("ordena por iniciativa (maior primeiro) e prepara o 1º turno", () => {
    const combat = buildCombat([
      mkCombatant({ name: "Slow", kind: "enemy", initiative: 5 }),
      mkCombatant({ name: "Fast", kind: "player", initiative: 22 }),
      mkCombatant({ name: "Mid", kind: "enemy", initiative: 12 }),
    ]);
    expect(combat.combatants.map((c) => c.name)).toEqual(["Fast", "Mid", "Slow"]);
    expect(combat.round).toBe(1);
    expect(combat.turnIndex).toBe(0);
    expect(combat.active).toBe(true);
    expect(combat.combatants[0]!.actionsRemaining).toBe(3);
  });
});

describe("advanceTurn", () => {
  it("passa para o próximo, reseta recursos e não incrementa round no meio", () => {
    const combat = buildCombat([
      mkCombatant({ name: "A", kind: "player", initiative: 20, mapProgress: 2, actionsRemaining: 0 }),
      mkCombatant({ name: "B", kind: "enemy", initiative: 10 }),
    ]);
    advanceTurn(combat);
    expect(combat.turnIndex).toBe(1);
    expect(combat.round).toBe(1);
    const b = combat.combatants[1]!;
    expect(b.actionsRemaining).toBe(3);
    expect(b.mapProgress).toBe(0);
    expect(b.reactionAvailable).toBe(true);
  });

  it("incrementa o round ao dar a volta", () => {
    const combat = buildCombat([
      mkCombatant({ name: "A", kind: "player", initiative: 20 }),
      mkCombatant({ name: "B", kind: "enemy", initiative: 10 }),
    ]);
    advanceTurn(combat); // -> B
    advanceTurn(combat); // -> A, novo round
    expect(combat.turnIndex).toBe(0);
    expect(combat.round).toBe(2);
  });

  it("pula combatentes derrotados sem contar round múltiplas vezes", () => {
    const combat = buildCombat([
      mkCombatant({ name: "A", kind: "player", initiative: 30 }),
      mkCombatant({ name: "B", kind: "enemy", initiative: 20, defeated: true }),
      mkCombatant({ name: "C", kind: "enemy", initiative: 10 }),
    ]);
    advanceTurn(combat); // pula B derrotado, vai pra C
    expect(combat.combatants[combat.turnIndex]!.name).toBe("C");
    expect(combat.round).toBe(1);
    advanceTurn(combat); // volta pra A -> round 2
    expect(combat.combatants[combat.turnIndex]!.name).toBe("A");
    expect(combat.round).toBe(2);
  });
});

describe("combatStatus", () => {
  it("victory quando não há inimigos de pé", () => {
    const combat = buildCombat([
      mkCombatant({ name: "Hero", kind: "player" }),
      mkCombatant({ name: "Foe", kind: "enemy", defeated: true }),
    ]);
    expect(combatStatus(combat)).toBe("victory");
  });

  it("defeat quando o jogador está caído", () => {
    const combat = buildCombat([
      mkCombatant({ name: "Hero", kind: "player", defeated: true }),
      mkCombatant({ name: "Foe", kind: "enemy" }),
    ]);
    expect(combatStatus(combat)).toBe("defeat");
  });

  it("ongoing enquanto ambos os lados têm combatentes", () => {
    const combat = buildCombat([
      mkCombatant({ name: "Hero", kind: "player" }),
      mkCombatant({ name: "Foe", kind: "enemy" }),
    ]);
    expect(combatStatus(combat)).toBe("ongoing");
  });
});

describe("applyRecovery (dying RAW)", () => {
  it("flat check DC 10+dying: sucesso −1, falha +1, margens ±10 dobram", () => {
    // dying 1 → DC 11
    expect(applyRecovery(11, 1)).toEqual({ degree: "success", newDying: 0 });
    expect(applyRecovery(10, 1)).toEqual({ degree: "failure", newDying: 2 });
    // dying 2 → DC 12: crit success precisa 20+ (só nat 20 via bump)
    expect(applyRecovery(20, 2)).toEqual({ degree: "criticalSuccess", newDying: 0 });
    // nat 1 desce um grau: failure → critical failure (+2)
    expect(applyRecovery(1, 1).newDying).toBe(3);
  });

  it("nunca fica negativo", () => {
    expect(applyRecovery(20, 1).newDying).toBe(0);
  });
});

describe("conditionValueIn / setValuedCondition", () => {
  it("lê e escreve condições valoradas em string[]", () => {
    expect(conditionValueIn(["dying 2", "unconscious"], "dying")).toBe(2);
    expect(conditionValueIn(["wounded"], "wounded")).toBe(1);
    expect(conditionValueIn([], "dying")).toBe(0);
    expect(setValuedCondition(["dying 2", "unconscious"], "dying", 3)).toEqual([
      "unconscious",
      "dying 3",
    ]);
    expect(setValuedCondition(["dying 1"], "dying", 0)).toEqual([]);
  });
});

describe("clampActionCost", () => {
  it("default 1 para ausente/inválido; clampa em 1..3; arredonda", () => {
    expect(clampActionCost(undefined)).toBe(1);
    expect(clampActionCost(null)).toBe(1);
    expect(clampActionCost("")).toBe(1);
    expect(clampActionCost("abc")).toBe(1);
    expect(clampActionCost(2)).toBe(2);
    expect(clampActionCost("3")).toBe(3);
    expect(clampActionCost(0)).toBe(1);
    expect(clampActionCost(-2)).toBe(1);
    expect(clampActionCost(7)).toBe(3);
    expect(clampActionCost(2.6)).toBe(3);
  });

  it("fallback 0 (save reativo): ausente é grátis, mas 'actions: 1' paga", () => {
    expect(clampActionCost(undefined, 0)).toBe(0);
    expect(clampActionCost(1, 0)).toBe(1);
    expect(clampActionCost(0, 0)).toBe(0);
    expect(clampActionCost(3, 0)).toBe(3);
  });
});

describe("findCombatant", () => {
  it("acha por id, nome exato e substring", () => {
    const combat = buildCombat([
      mkCombatant({ name: "Clockwork Sentinel 1", kind: "enemy", id: "s1" }),
      mkCombatant({ name: "Clockwork Sentinel 2", kind: "enemy", id: "s2" }),
    ]);
    expect(findCombatant(combat, "s2")!.id).toBe("s2");
    expect(findCombatant(combat, "Clockwork Sentinel 1")!.id).toBe("s1");
    expect(findCombatant(combat, "sentinel 2")!.id).toBe("s2");
    expect(findCombatant(combat, "nobody")).toBeUndefined();
  });

  it("aceita o formato 'Nome [id:xxx]' que o bloco de combate ensina ao modelo", () => {
    const combat = buildCombat([
      mkCombatant({ name: "Vexcia (Administrator)", kind: "enemy", id: "b6429ab6" }),
      mkCombatant({ name: "Jão", kind: "player", id: "p1" }),
    ]);
    // O caso exato do replay: nome completo + tag de id.
    expect(findCombatant(combat, "Vexcia (Administrator) [id:b6429ab6]")!.id).toBe("b6429ab6");
    // Tag de id sozinha, com espaços.
    expect(findCombatant(combat, "[id: b6429ab6 ]")!.id).toBe("b6429ab6");
    // Tag de id desconhecida cai no match por nome.
    expect(findCombatant(combat, "Vexcia (Administrator) [id:errado]")!.id).toBe("b6429ab6");
    // Fuzzy nas duas direções: referência mais longa que o nome real.
    expect(findCombatant(combat, "Vexcia the clerk")!.id).toBe("b6429ab6");
    expect(findCombatant(combat, "vexcia")!.id).toBe("b6429ab6");
  });
});

describe("beginPlayerRound", () => {
  it("recarrega ações/reação e zera MAP (sem mexer no round)", () => {
    const combat = buildCombat([
      mkCombatant({ name: "Hero", kind: "player", initiative: 20, actionsRemaining: 0, mapProgress: 2, reactionAvailable: false }),
      mkCombatant({ name: "Foe", kind: "enemy", initiative: 10, mapProgress: 3 }),
    ]);
    beginPlayerRound(combat);
    expect(combat.round).toBe(1); // round avança só ao fechar a rodada (turno dos inimigos)
    for (const c of combat.combatants) {
      expect(c.actionsRemaining).toBe(3);
      expect(c.mapProgress).toBe(0);
      expect(c.reactionAvailable).toBe(true);
    }
  });

  it("não recarrega ações de combatentes derrotados", () => {
    const combat = buildCombat([
      mkCombatant({ name: "Hero", kind: "player" }),
      mkCombatant({ name: "Foe", kind: "enemy", defeated: true, actionsRemaining: 0 }),
    ]);
    beginPlayerRound(combat);
    expect(combat.combatants[1]!.actionsRemaining).toBe(0);
  });
});

describe("livingEnemy", () => {
  it("prefere o combatente ativo se for um inimigo vivo", () => {
    const combat = buildCombat([
      mkCombatant({ name: "Foe A", kind: "enemy", initiative: 30 }),
      mkCombatant({ name: "Hero", kind: "player", initiative: 20 }),
      mkCombatant({ name: "Foe B", kind: "enemy", initiative: 10 }),
    ]);
    // turnIndex 0 = Foe A (ativo)
    expect(livingEnemy(combat)!.name).toBe("Foe A");
  });

  it("cai para o 1º inimigo vivo quando o ativo não é inimigo", () => {
    const combat = buildCombat([
      mkCombatant({ name: "Hero", kind: "player", initiative: 30 }),
      mkCombatant({ name: "Foe A", kind: "enemy", initiative: 20, defeated: true }),
      mkCombatant({ name: "Foe B", kind: "enemy", initiative: 10 }),
    ]);
    expect(livingEnemy(combat)!.name).toBe("Foe B");
  });
});

describe("condições como mecânica", () => {
  it("conditionValue lê valor, assume 1 sem número e 0 quando ausente", () => {
    const c = mkCombatant({ name: "X", kind: "enemy", conditions: ["frightened 2", "prone"] });
    expect(conditionValue(c, "frightened")).toBe(2);
    expect(conditionValue(c, "prone")).toBe(1);
    expect(conditionValue(c, "sickened")).toBe(0);
  });

  it("isOffGuard aceita off-guard e flat-footed", () => {
    expect(isOffGuard(mkCombatant({ name: "A", kind: "enemy", conditions: ["off-guard"] }))).toBe(true);
    expect(isOffGuard(mkCombatant({ name: "B", kind: "enemy", conditions: ["Flat-Footed"] }))).toBe(true);
    expect(isOffGuard(mkCombatant({ name: "C", kind: "enemy" }))).toBe(false);
  });

  it("effectiveAC: −2 off-guard e −N frightened acumulam", () => {
    const base = mkCombatant({ name: "T", kind: "enemy", ac: 18 });
    expect(effectiveAC(base)).toBe(18);
    const og = mkCombatant({ name: "T", kind: "enemy", ac: 18, conditions: ["off-guard"] });
    expect(effectiveAC(og)).toBe(16);
    const both = mkCombatant({
      name: "T",
      kind: "enemy",
      ac: 18,
      conditions: ["off-guard", "frightened 1"],
    });
    expect(effectiveAC(both)).toBe(15);
  });

  it("attackStatusPenalty: frightened 2 → −2; sem condição → 0", () => {
    expect(
      attackStatusPenalty(mkCombatant({ name: "A", kind: "enemy", conditions: ["frightened 2"] })),
    ).toBe(-2);
    expect(attackStatusPenalty(mkCombatant({ name: "B", kind: "enemy" }))).toBe(0);
  });

  it("tickEndOfRound: off-guard expira, frightened decai, prone fica", () => {
    const combat = buildCombat([
      mkCombatant({
        name: "Hero",
        kind: "player",
        conditions: ["off-guard", "frightened 2", "prone"],
      }),
      mkCombatant({ name: "Foe", kind: "enemy", conditions: ["flat-footed", "frightened 1"] }),
    ]);
    tickEndOfRound(combat);
    const [hero, foe] = combat.combatants;
    expect(hero!.conditions).toEqual(["frightened 1", "prone"]);
    expect(foe!.conditions).toEqual([]); // flat-footed expira, frightened 1 → 0 → some
    tickEndOfRound(combat);
    expect(hero!.conditions).toEqual(["prone"]);
  });
});

describe("hasCombatantNamed", () => {
  const combat = buildCombat([
    mkCombatant({ name: "Jão", kind: "player" }),
    mkCombatant({ name: "Gate Administrator (Human)", kind: "enemy" }),
  ]);

  it("casa nome quase-igual (ignora sufixo em parênteses) — evita duplicata", () => {
    expect(hasCombatantNamed(combat, "Gate Administrator")).toBe(true);
    expect(hasCombatantNamed(combat, "gate administrator (human)")).toBe(true);
    expect(hasCombatantNamed(combat, "Administrator")).toBe(true); // substring
  });

  it("não casa inimigo genuinamente novo (entra como reforço)", () => {
    expect(hasCombatantNamed(combat, "Clockwork Scout")).toBe(false);
    expect(hasCombatantNamed(combat, "")).toBe(false);
  });
});

describe("benchmark", () => {
  it("dá stats plausíveis e clampa fora da faixa", () => {
    expect(benchmark(1).ac).toBeGreaterThan(10);
    expect(benchmark(1).hp).toBeGreaterThan(0);
    // Abaixo/acima da tabela clampa nos extremos (sem crash).
    expect(benchmark(-5)).toEqual(benchmark(-1));
    expect(benchmark(99)).toEqual(benchmark(12));
  });
});

describe("passiveFeatBonus / playerCombatant (passivos da engine)", () => {
  const sheet = (feats: string[]): Character =>
    ({
      name: "Hero",
      level: 5,
      perception: 10,
      ac: 20,
      maxHp: 50,
      feats,
    }) as unknown as Character;

  it("Incredible Initiative soma +2 na iniciativa", () => {
    const bonus = passiveFeatBonus(sheet(["Incredible Initiative", "Toughness"]), "initiative");
    expect(bonus).toEqual({ total: 2, sources: ["Incredible Initiative"] });
  });

  it("sem o feat, bônus zero", () => {
    expect(passiveFeatBonus(sheet(["Toughness"]), "initiative").total).toBe(0);
  });

  it("playerCombatant aplica o passivo: iniciativa mínima = 1 + perception + 2", () => {
    // d20 mínimo 1: com o feat, init ≥ 13; sem, pode ser 11. Roda várias vezes
    // e checa o PISO (determinístico o suficiente sem mockar RNG).
    for (let i = 0; i < 50; i++) {
      const withFeat = playerCombatant(sheet(["Incredible Initiative"]), 50);
      expect(withFeat.initiative).toBeGreaterThanOrEqual(13);
      expect(withFeat.initiative).toBeLessThanOrEqual(32);
    }
  });
});
