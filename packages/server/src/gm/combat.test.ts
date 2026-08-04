import { afterEach, describe, expect, it } from "vitest";
import type { Combatant } from "@pf2e/shared";
import { rollOptionsFor, type RollOptions } from "../rules/roll-options.js";
import {
  advanceTurn,
  setConditionModifierSource,
  applyDamage,
  applyRecovery,
  attackStatusPenalty,
  beginPlayerRound,
  benchmark,
  buildCombat,
  clampActionCost,
  classifyEncounter,
  combatStatus,
  conditionValueIn,
  conditionValue,
  creatureXp,
  effectiveAC,
  encounterBudget,
  findCombatant,
  enemyCombatant,
  hasCombatantNamed,
  isOffGuard,
  livingEnemy,
  mapPenalty,
  partySizeOf,
  setActorModifierSource,
  planEncounter,
  playerCombatant,
  setValuedCondition,
  strikeProfileFrom,
  tickPersistentDamage,
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

describe("applyDamage tipado (Fase 2.5 / T1)", () => {
  it("resistência do alvo reduz o HP perdido e explica na nota", () => {
    const c = mkCombatant({
      name: "Skeleton",
      kind: "enemy",
      currentHp: 20,
      resistances: [{ type: "slashing", value: 5 }],
    });
    const adj = applyDamage(c, [{ amount: 12, type: "slashing" }]);
    expect(c.currentHp).toBe(13);
    expect(adj.raw).toBe(12);
    expect(adj.applied).toBe(7);
    expect(adj.note).toContain("resistance slashing -5");
  });

  it("fraqueza do alvo aumenta o dano — e pode derrubá-lo", () => {
    const c = mkCombatant({
      name: "Vampire Spawn",
      kind: "enemy",
      currentHp: 8,
      weaknesses: [{ type: "fire", value: 5 }],
    });
    applyDamage(c, [{ amount: 5, type: "fire" }]);
    expect(c.currentHp).toBe(0);
    expect(c.defeated).toBe(true);
  });

  it("imunidade zera o dano: o alvo NÃO perde HP nem é derrotado", () => {
    const c = mkCombatant({
      name: "Fire Elemental",
      kind: "enemy",
      currentHp: 3,
      immunities: ["fire"],
    });
    const adj = applyDamage(c, [{ amount: 40, type: "fire" }]);
    expect(c.currentHp).toBe(3);
    expect(c.defeated).toBe(false);
    expect(adj.applied).toBe(0);
  });

  it("golpe multi-tipo mede cada parcela contra a defesa certa", () => {
    // Statblock com "1d8 piercing + 1d6 fire" contra quem só resiste a fogo.
    const c = mkCombatant({
      name: "Salamander",
      kind: "enemy",
      currentHp: 30,
      resistances: [{ type: "fire", value: 10 }],
    });
    applyDamage(c, [
      { amount: 8, type: "piercing" },
      { amount: 6, type: "fire" },
    ]);
    expect(c.currentHp).toBe(22); // 8 passa inteiro, 6 de fogo somem
  });

  it("dano sem tipo (update_state/hpDelta) ignora defesa tipada", () => {
    const c = mkCombatant({
      name: "Golem",
      kind: "enemy",
      currentHp: 20,
      resistances: [{ type: "physical", value: 10 }],
    });
    applyDamage(c, 12);
    expect(c.currentHp).toBe(8);
  });

  it("resistência incide DEPOIS do dobro do crítico", () => {
    const c = mkCombatant({
      name: "Guard",
      kind: "enemy",
      currentHp: 40,
      resistances: [{ type: "piercing", value: 5 }],
    });
    // O call site dobra a parcela antes de aplicar: (6×2) − 5 = 7, não (6−5)×2.
    applyDamage(c, [{ amount: 6 * 2, type: "piercing" }]);
    expect(c.currentHp).toBe(33);
  });

  it("combatente sem defesas declaradas se comporta como antes", () => {
    const c = mkCombatant({ name: "Thug", kind: "enemy", currentHp: 10 });
    const adj = applyDamage(c, [{ amount: 4, type: "slashing" }]);
    expect(c.currentHp).toBe(6);
    expect(adj.note).toBe("");
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

  /**
   * O contexto da rolagem tem de CHEGAR à fonte de modificadores (T5.2). Até
   * aqui `ConditionModifierSource` não tinha esse parâmetro, então
   * `conditionModifiersFor` recebia `ro` indefinido e descartava todo
   * FlatModifier com predicado — o caminho condicional existia e estava morto.
   */
  describe("o contexto da rolagem chega à fonte de modificadores", () => {
    afterEach(() => setConditionModifierSource(null));

    it("effectiveAC e attackStatusPenalty repassam as roll options", () => {
      const seen: (RollOptions | undefined)[] = [];
      setConditionModifierSource((_conds, _sel, ro) => {
        seen.push(ro);
        return [];
      });
      const ro = rollOptionsFor({ action: "Strike" });
      effectiveAC(mkCombatant({ name: "T", kind: "enemy" }), ro);
      attackStatusPenalty(mkCombatant({ name: "A", kind: "enemy" }), ro);
      expect(seen).toEqual([ro, ro]);
    });

    it("sem contexto, a fonte recebe `undefined` — e não um objeto vazio", () => {
      // A diferença importa: `{}` seria um contexto que não cobre NADA, mas
      // ainda assim um contexto. `undefined` é o sinal de "sem rolagem".
      const seen: (RollOptions | undefined)[] = [];
      setConditionModifierSource((_conds, _sel, ro) => {
        seen.push(ro);
        return [];
      });
      effectiveAC(mkCombatant({ name: "T", kind: "enemy" }));
      expect(seen).toEqual([undefined]);
    });

    it("o seletor continua chegando junto", () => {
      const seen: string[] = [];
      setConditionModifierSource((_conds, sel) => {
        seen.push(sel);
        return [];
      });
      const c = mkCombatant({ name: "T", kind: "enemy" });
      effectiveAC(c);
      attackStatusPenalty(c);
      expect(seen).toEqual(["ac", "attack-roll"]);
    });
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

  it("variantes de escape quebrado do modelo casam (play-test 2026-07-11)", () => {
    // O 12B nomeou `Scavenger\" (Thug)` num turno e `Scavenger" (Thug)` no
    // seguinte — o dedupe deixou passar e o encontro dobrou de tamanho.
    const c = buildCombat([
      mkCombatant({ name: 'Scavenger Scavenger\\" (Thug) 1', kind: "enemy" }),
    ]);
    expect(hasCombatantNamed(c, 'Scavenger Scavenger" (Thug) 1')).toBe(true);
    expect(hasCombatantNamed(c, "Scavenger Scavenger (Thug) 1")).toBe(true);
    // Dígito diferente continua sendo OUTRO combatente.
    expect(hasCombatantNamed(c, 'Scavenger Scavenger" (Thug) 2')).toBe(false);
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

describe("orçamento de encontro (GM Core, party de 1)", () => {
  it("creatureXp: os 9 deltas RAW; abaixo de PL-4 = 0; acima de PL+4 = proibido", () => {
    const partyLevel = 5;
    const expected = [10, 15, 20, 30, 40, 60, 80, 120, 160];
    for (let delta = -4; delta <= 4; delta++) {
      expect(creatureXp(partyLevel + delta, partyLevel)).toBe(expected[delta + 4]);
    }
    expect(creatureXp(0, 5)).toBe(0); // PL-5: não conta
    expect(creatureXp(10, 5)).toBeNull(); // PL+5: nunca entra
  });

  it("encounterBudget: party 4 = tabela RAW; party 1 = 1× ajuste; escala nos dois sentidos", () => {
    expect(encounterBudget("trivial", 4)).toBe(40);
    expect(encounterBudget("low", 4)).toBe(60);
    expect(encounterBudget("moderate", 4)).toBe(80);
    expect(encounterBudget("severe", 4)).toBe(120);
    expect(encounterBudget("extreme", 4)).toBe(160);
    expect(encounterBudget("trivial", 1)).toBe(10);
    expect(encounterBudget("low", 1)).toBe(15);
    expect(encounterBudget("moderate", 1)).toBe(20);
    expect(encounterBudget("severe", 1)).toBe(30);
    expect(encounterBudget("extreme", 1)).toBe(40);
    expect(encounterBudget("moderate", 2)).toBe(40);
    expect(encounterBudget("severe", 5)).toBe(150);
  });

  it("classifyEncounter: menor dificuldade que cobre o XP", () => {
    expect(classifyEncounter(10, 1)).toBe("trivial");
    expect(classifyEncounter(20, 1)).toBe("moderate");
    expect(classifyEncounter(28, 1)).toBe("severe");
    expect(classifyEncounter(40, 1)).toBe("extreme");
    expect(classifyEncounter(999, 1)).toBe("extreme");
  });

  it("partySizeOf: player + allies, nunca menos que 1", () => {
    expect(
      partySizeOf([
        mkCombatant({ name: "Hero", kind: "player" }),
        mkCombatant({ name: "Guide", kind: "ally" }),
        mkCombatant({ name: "Rat", kind: "enemy" }),
      ]),
    ).toBe(2);
    expect(partySizeOf([])).toBe(1);
  });

  it("planEncounter corta criatura a criatura o que estoura (caso real 2026-07-11)", () => {
    // PC level 5 solo, extreme (40 XP): 3× thug lvl 1 (10 cada) + hound lvl 2 (15)
    // = 45 XP → só 3 thugs + NADA de hound? Não: 10+10+10=30, hound 15 estoura
    // (45 > 40) → hound fica de fora.
    const plan = planEncounter(
      [
        { name: "Thug", level: 1, count: 3 },
        { name: "Scavenger Hound", level: 2, count: 1 },
      ],
      0,
      { partyLevel: 5, partySize: 1, difficulty: "extreme" },
    );
    expect(plan.accepted).toEqual([{ name: "Thug", level: 1, count: 3 }]);
    expect(plan.trimmedOver).toEqual([{ name: "Scavenger Hound", level: 2, count: 1 }]);
    expect(plan.totalXp).toBe(30);
    expect(plan.budget).toBe(40);
    expect(plan.classified).toBe("severe");
    expect(plan.fits).toBe(false);
  });

  it("planEncounter: PL+5 é proibido mesmo em extreme", () => {
    const plan = planEncounter(
      [
        { name: "Dragon", level: 10, count: 1 },
        { name: "Kobold", level: 1, count: 1 },
      ],
      0,
      { partyLevel: 5, partySize: 1, difficulty: "extreme" },
    );
    expect(plan.droppedForbidden).toEqual([{ name: "Dragon", level: 10, count: 1 }]);
    expect(plan.accepted).toEqual([{ name: "Kobold", level: 1, count: 1 }]);
  });

  it("planEncounter anti-vazio: combate novo nunca começa sem inimigo", () => {
    // Única criatura declarada não cabe (lvl 5 = 40 XP > moderate 20) →
    // rebaixada para o maior level que caiba (lvl 3 = 20 XP).
    const plan = planEncounter([{ name: "Ogre", level: 5, count: 1 }], 0, {
      partyLevel: 5,
      partySize: 1,
      difficulty: "moderate",
    });
    expect(plan.accepted).toEqual([{ name: "Ogre", level: 3, count: 1 }]);
    expect(plan.downleveled).toEqual({ name: "Ogre", from: 5, to: 3 });
    expect(plan.trimmedOver).toEqual([]); // o rebaixado saiu da lista de cortes
    expect(plan.totalXp).toBe(20);
  });

  it("planEncounter: reforços partem do XP já em campo e não ganham anti-vazio", () => {
    // Campo já com 30 XP; reforço de 15 estoura extreme 40 → nada entra.
    const plan = planEncounter([{ name: "Hound", level: 2, count: 1 }], 30, {
      partyLevel: 5,
      partySize: 1,
      difficulty: "extreme",
    });
    expect(plan.accepted).toEqual([]);
    expect(plan.trimmedOver).toEqual([{ name: "Hound", level: 2, count: 1 }]);
    expect(plan.totalXp).toBe(30);
  });

  it("planEncounter: criaturas PL-5 custam 0 e entram todas (trivial)", () => {
    const plan = planEncounter([{ name: "Rat", level: -1, count: 8 }], 0, {
      partyLevel: 5,
      partySize: 1,
      difficulty: "moderate",
    });
    expect(plan.accepted).toEqual([{ name: "Rat", level: -1, count: 8 }]);
    expect(plan.totalXp).toBe(0);
    expect(plan.classified).toBe("trivial");
    expect(plan.fits).toBe(true);
  });
});

/**
 * Os passivos da ficha deixaram de morar numa tabela escrita à mão
 * (`PASSIVE_FEAT_EFFECTS`, uma entrada) e passaram a vir do dado via fonte
 * injetada (T5.4). O que se testa AQUI é o contrato da injeção — que o número
 * do dado é o número que a iniciativa usa. Que o dado realmente diz "+2 para
 * Incredible Initiative" é asserção de `rules/actor-modifiers.test.ts`.
 */
describe("playerCombatant — passivos vindos da fonte injetada", () => {
  afterEach(() => setActorModifierSource(null));

  const sheet = (feats: string[]): Character =>
    ({
      name: "Hero",
      level: 5,
      perception: 10,
      ac: 20,
      maxHp: 50,
      feats,
    }) as unknown as Character;

  it("a fonte recebe o seletor `initiative` e a ficha inteira", () => {
    const seen: { selector: string | string[]; feats: string[] }[] = [];
    setActorModifierSource((character, selector) => {
      seen.push({ selector, feats: character.feats });
      return [];
    });
    playerCombatant(sheet(["Incredible Initiative"]), 50);
    expect(seen).toEqual([{ selector: "initiative", feats: ["Incredible Initiative"] }]);
  });

  it("o bônus da fonte entra na iniciativa (piso = 1 + perception + bônus)", () => {
    setActorModifierSource(() => [
      { slug: "incredible-initiative", type: "circumstance", value: 2 },
    ]);
    for (let i = 0; i < 50; i++) {
      const c = playerCombatant(sheet(["Incredible Initiative"]), 50);
      expect(c.initiative).toBeGreaterThanOrEqual(13);
      expect(c.initiative).toBeLessThanOrEqual(32);
    }
  });

  it("dois bônus do MESMO tipo não somam nem aqui", () => {
    setActorModifierSource(() => [
      { slug: "a", type: "circumstance", value: 2 },
      { slug: "b", type: "circumstance", value: 1 },
    ]);
    for (let i = 0; i < 20; i++) {
      const c = playerCombatant(sheet([]), 50);
      expect(c.initiative).toBeGreaterThanOrEqual(13);
      expect(c.initiative).toBeLessThanOrEqual(32);
    }
  });

  it("sem fonte registrada, a ficha não contribui — e não quebra", () => {
    for (let i = 0; i < 20; i++) {
      const c = playerCombatant(sheet(["Incredible Initiative"]), 50);
      expect(c.initiative).toBeGreaterThanOrEqual(11);
      expect(c.initiative).toBeLessThanOrEqual(30);
    }
  });
});

describe("enemyCombatant / strikeProfileFrom (statblock literal, sem dataset)", () => {
  const sb = {
    ac: 15,
    hp: 8,
    perception: 5,
    saves: { fortitude: 6, reflex: 7, will: 3 },
    attacks: [
      {
        name: "Shortbow",
        bonus: 7,
        damage: [{ formula: "1d6", type: "piercing" }],
        traits: ["deadly-d10"],
        rangeIncrement: 60,
      },
      {
        name: "Jaws",
        bonus: 7,
        damage: [
          { formula: "1d6+1", type: "piercing" },
          { formula: "1d4", type: "persistent bleed", category: "persistent" },
        ],
        traits: ["agile", "finesse"],
      },
    ],
    abilitiesList: [],
  };

  it("com statblock usa AC/HP/saves/sourceName reais", () => {
    const c = enemyCombatant("Giant Rat 1", -1, {
      ...sb,
      sourceName: "Giant Rat",
      traits: ["animal"],
    });
    expect(c.ac).toBe(15);
    expect(c.maxHp).toBe(8);
    expect(c.currentHp).toBe(8);
    expect(c.saves).toEqual({ fortitude: 6, reflex: 7, will: 3 });
    expect(c.sourceName).toBe("Giant Rat");
    expect(c.traits).toEqual(["animal"]);
    expect(c.level).toBe(-1);
  });

  it("sem statblock mantém o benchmark do nível (comportamento antigo)", () => {
    const c = enemyCombatant("Cinzalto Enforcer", 2);
    const b = benchmark(2);
    expect(c.ac).toBe(b.ac);
    expect(c.maxHp).toBe(b.hp);
    expect(c.sourceName).toBeUndefined();
    expect(c.saves).toBeUndefined();
    expect(c.resistances).toBeUndefined();
  });

  it("traz imunidade/fraqueza/resistência do statblock para o combate", () => {
    const c = enemyCombatant("Skeleton Guard", 0, {
      ...sb,
      sourceName: "Skeleton Guard",
      traits: ["undead"],
      immunities: ["death-effects", "poison"],
      weaknesses: [{ type: "bludgeoning", value: 5 }],
      resistances: [{ type: "cold", value: 5 }],
    });
    expect(c.immunities).toEqual(["death-effects", "poison"]);
    expect(c.weaknesses).toEqual([{ type: "bludgeoning", value: 5 }]);
    // E o dado chega até a aplicação: 4 de maça viram 9 pela fraqueza, e o
    // esqueleto de 8 HP cai — sem a fraqueza sobrariam 4 HP.
    const adj = applyDamage(c, [{ amount: 4, type: "bludgeoning" }]);
    expect(adj.applied).toBe(9);
    expect(c.currentHp).toBe(0);
    expect(c.defeated).toBe(true);
  });

  it("strikeProfileFrom prefere melee sobre ranged e lê agile das traits", () => {
    const p = strikeProfileFrom(sb, -1);
    expect(p.label).toBe("Jaws");
    expect(p.bonus).toBe(7);
    expect(p.agile).toBe(true);
    // PR2: dano persistente fica fora do golpe direto por enquanto.
    expect(p.damage).toEqual([{ formula: "1d6+1", type: "piercing" }]);
  });

  it("strikeProfileFrom sem statblock cai no benchmark (não-agile)", () => {
    const p = strikeProfileFrom(undefined, 2);
    const b = benchmark(2);
    expect(p.label).toBe("Strike");
    expect(p.bonus).toBe(b.attack);
    expect(p.agile).toBe(false);
    expect(p.damage).toEqual([
      { formula: `${b.damage.dice}d${b.damage.faces}+${b.damage.bonus}`, type: "damage" },
    ]);
  });

  it("statblock só com ataques ranged usa o primeiro mesmo assim", () => {
    const ranged = { ...sb, attacks: [sb.attacks[0]!] };
    const p = strikeProfileFrom(ranged, -1);
    expect(p.label).toBe("Shortbow");
    expect(p.agile).toBe(false);
  });
});

describe("persistent damage (PR2)", () => {
  it("tickEndOfRound NÃO decrementa persistent/dying/wounded, mas decrementa frightened", () => {
    const c = mkCombatant({
      name: "Hero",
      kind: "player",
      conditions: ["persistent fire damage 2", "dying 2", "wounded 1", "frightened 2"],
    });
    const combat = buildCombat([c]);
    tickEndOfRound(combat);
    expect(c.conditions).toContain("persistent fire damage 2");
    expect(c.conditions).toContain("dying 2");
    expect(c.conditions).toContain("wounded 1");
    expect(c.conditions).toContain("frightened 1");
  });

  it("tickPersistentDamage: valor flat causa dano exato e flat check decide o fim", () => {
    const c = mkCombatant({
      name: "Goblin",
      kind: "enemy",
      currentHp: 12,
      conditions: ["persistent fire damage 3"],
    });
    const combat = buildCombat([c]);
    const ticks = tickPersistentDamage(combat);
    expect(ticks).toHaveLength(1);
    const t = ticks[0]!;
    expect(t.amount).toBe(3);
    expect(t.before).toBe(12);
    expect(t.after).toBe(9);
    expect(c.currentHp).toBe(9);
    // Condição removida SSE o flat check (d20 ≥ 15) passou.
    expect(t.ended).toBe(t.flatRoll >= 15);
    expect(c.conditions.includes("persistent fire damage 3")).toBe(!t.ended);
  });

  it("tickPersistentDamage: fórmula NdM rola no intervalo e derrotado perde a condição", () => {
    const c = mkCombatant({
      name: "Rat",
      kind: "enemy",
      currentHp: 2,
      conditions: ["persistent bleed damage 1d4+1"],
    });
    const combat = buildCombat([c]);
    const t = tickPersistentDamage(combat)[0]!;
    expect(t.amount).toBeGreaterThanOrEqual(2);
    expect(t.amount).toBeLessThanOrEqual(5);
    // 2 HP e dano mínimo 2 → derrotado; morto não continua sangrando.
    expect(c.defeated).toBe(true);
    expect(c.conditions).toEqual([]);
  });

  it("tickPersistentDamage ignora quem já está derrotado", () => {
    const c = mkCombatant({
      name: "Corpse",
      kind: "enemy",
      currentHp: 0,
      defeated: true,
      conditions: ["persistent fire damage 4"],
    });
    const combat = buildCombat([c]);
    expect(tickPersistentDamage(combat)).toEqual([]);
  });

  it("strikeProfileFrom separa dano persistente do direto", () => {
    const sb = {
      ac: 14,
      hp: 10,
      perception: 4,
      saves: { fortitude: 5, reflex: 6, will: 2 },
      attacks: [
        {
          name: "Fangs",
          bonus: 8,
          damage: [
            { formula: "1d8+2", type: "piercing" },
            { formula: "1d4", type: "bleed", category: "persistent" },
          ],
          traits: [],
        },
      ],
      abilitiesList: [],
    };
    const p = strikeProfileFrom(sb, 1);
    expect(p.damage).toEqual([{ formula: "1d8+2", type: "piercing" }]);
    expect(p.persistent).toEqual([{ formula: "1d4", type: "bleed" }]);
  });
});
