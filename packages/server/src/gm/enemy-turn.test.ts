import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Character, Combatant, GameState } from "@pf2e/shared";
import {
  commitFrequency,
  findSheetWeapon,
  frequencyLimit,
  isOfficialCondition,
  requirementBlocked,
  reactionTriggerOf,
  resolveEnemyTurns,
  triggerEnemyReactions,
} from "./agent.js";
import { buildCombat } from "./combat.js";
import type { Session } from "./sessions.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));

/** Minimal combatant (deterministic — no RNG). */
function mk(partial: Partial<Combatant> & Pick<Combatant, "name" | "kind">): Combatant {
  return {
    id: partial.name.toLowerCase().replace(/\s+/g, "-"),
    initiative: 10,
    ac: 15,
    maxHp: 40,
    currentHp: 40,
    conditions: [],
    actionsRemaining: 3,
    reactionAvailable: true,
    mapProgress: 0,
    level: 1,
    traits: [],
    defeated: false,
    ...partial,
  };
}

/** A session with state.combat + currentHp and a minimal character (name). */
function sessionWith(player: Combatant, ...enemies: Combatant[]): Session {
  const combat = buildCombat([player, ...enemies]);
  const state: GameState = {
    sessionId: "t",
    currentHp: player.currentHp,
    conditions: [],
    flags: {},
    combat,
  };
  return {
    id: "t",
    state,
    character: { name: player.name, maxHp: player.maxHp },
  } as unknown as Session;
}

const noop = () => {};

// Frequency lê o dataset gerado (gitignorado) — pulado em clone fresco.
describe.skipIf(!hasGenerated)("frequency enforcement (requer generated/)", () => {
  // Fixtures do dataset: "Sharpened Senses" = 1/round; "Chilling Paralysis" = 1/PT1H.
  const freshSession = (combatActive: boolean): Session =>
    ({
      id: "t",
      state: {
        sessionId: "t",
        currentHp: 10,
        conditions: [],
        flags: {},
        combat: combatActive ? { active: true, round: 1, turnIndex: 0, combatants: [] } : null,
      },
    }) as unknown as Session;

  it("once per round: 1º uso passa, 2º no mesmo turno é bloqueado", () => {
    const s = freshSession(false);
    const text = "I use Sharpened Senses to find the thief";
    expect(frequencyLimit(s, text)).toBeNull();
    commitFrequency(s, text);
    const blocked = frequencyLimit(s, text);
    expect(blocked?.isError).toBe(true);
    expect(blocked?.content).toContain("Frequency 1/round");
  });

  it("sessão nova (turno novo) libera o uso de novo", () => {
    const s1 = freshSession(false);
    commitFrequency(s1, "Sharpened Senses");
    expect(frequencyLimit(s1, "Sharpened Senses")?.isError).toBe(true);
    // WeakMap por sessão: outra sessão/turno não herda o gasto.
    expect(frequencyLimit(freshSession(false), "Sharpened Senses")).toBeNull();
  });

  it("período longo (1/hour): dentro do MESMO combate é bloqueado", () => {
    const s = freshSession(true);
    expect(frequencyLimit(s, "Chilling Paralysis on the guard")).toBeNull();
    commitFrequency(s, "Chilling Paralysis on the guard");
    expect(frequencyLimit(s, "I repeat Chilling Paralysis")?.isError).toBe(true);
  });

  it("período longo FORA de combate: engine não julga (tempo narrativo)", () => {
    const s = freshSession(false);
    commitFrequency(s, "Chilling Paralysis");
    expect(frequencyLimit(s, "Chilling Paralysis")).toBeNull();
  });

  it("texto sem atividade com frequency → null", () => {
    expect(frequencyLimit(freshSession(true), "I strike with my dagger")).toBeNull();
  });
});

describe.skipIf(!hasGenerated)("requirementBlocked (requer generated/)", () => {
  const weapon = (name: string) => ({ name, attack: 10, die: "d6", damageBonus: 0, damageType: "S" });
  const sessionWithSheet = (weapons: string[], equipment: string[] = []): Session =>
    ({
      character: {
        weapons: weapons.map(weapon),
        armor: [],
        equipment: equipment.map((name) => ({ name, qty: 1 })),
      },
    }) as unknown as Session;

  it("Double Slice com 1 arma → bloqueado; com 2 → passa", () => {
    const one = requirementBlocked(sessionWithSheet(["Longsword"]), "I use Double Slice");
    expect(one?.isError).toBe(true);
    expect(one?.content).toContain("Double Slice");
    expect(requirementBlocked(sessionWithSheet(["Longsword", "Shortsword"]), "I use Double Slice")).toBeNull();
  });

  it("Raise a Shield sem escudo → bloqueado; com escudo no Equipment → passa", () => {
    expect(requirementBlocked(sessionWithSheet(["Longsword"]), "Raise a Shield")?.isError).toBe(true);
    expect(
      requirementBlocked(sessionWithSheet(["Longsword"], ["Steel Shield"]), "Raise a Shield"),
    ).toBeNull();
  });

  it("requirement que a engine não julga (postura/estado) → passa", () => {
    // "Twin Feint" exige duas armas? Não — sem requirement dos padrões → null.
    expect(requirementBlocked(sessionWithSheet(["Dagger"]), "I strike with my dagger")).toBeNull();
  });
});

describe("isOfficialCondition (whitelist)", () => {
  it("aceita condições oficiais, com e sem valor", () => {
    expect(isOfficialCondition("frightened 2")).toBe(true);
    expect(isOfficialCondition("off-guard")).toBe(true);
    expect(isOfficialCondition("Prone")).toBe(true); // case-insensitive
    expect(isOfficialCondition("dying 3")).toBe(true);
    expect(isOfficialCondition("persistent fire damage 2")).toBe(true);
  });

  it("rejeita história-como-condição e nomes inventados", () => {
    expect(isOfficialCondition("companion: Cat")).toBe(false);
    expect(isOfficialCondition("angry")).toBe(false);
    expect(isOfficialCondition("blessed by the moon")).toBe(false);
    expect(isOfficialCondition("")).toBe(false);
  });
});

describe("findSheetWeapon", () => {
  const c = {
    weapons: [
      { name: "Dagger", attack: 13, die: "d4", damageBonus: 0, damageType: "P" },
      { name: "Shortbow", attack: 13, die: "d6", damageBonus: 0, damageType: "P" },
    ],
  } as unknown as Character;

  it("casa por nome exato (case-insensitive)", () => {
    expect(findSheetWeapon(c, "dagger")?.name).toBe("Dagger");
  });

  it("casa quando a referência CONTÉM o nome ('my trusty dagger')", () => {
    expect(findSheetWeapon(c, "my trusty dagger strike")?.name).toBe("Dagger");
  });

  it("casa quando o nome contém a referência ('shortb')", () => {
    expect(findSheetWeapon(c, "shortb")?.name).toBe("Shortbow");
  });

  it("null para arma que não está na ficha", () => {
    expect(findSheetWeapon(c, "greatsword")).toBeNull();
    expect(findSheetWeapon(c, "")).toBeNull();
  });
});

describe("resolveEnemyTurns", () => {
  it("cada inimigo vivo faz 2 Strikes contra o jogador", () => {
    // AC 1 força acerto sempre → dá pra contar as linhas com precisão.
    const player = mk({ name: "Hero", kind: "player", ac: 1, maxHp: 200, currentHp: 200 });
    const session = sessionWith(player, mk({ name: "Foe", kind: "enemy" }));
    const lines = resolveEnemyTurns(session, noop);
    // 2 Strikes de 1 inimigo (jogador não cai com 200 HP).
    expect(lines.filter((l) => l.includes("Strike vs Hero")).length).toBe(2);
    expect(session.state.currentHp).toBeLessThan(200);
  });

  it("não causa dano quando o jogador tem AC altíssima (todos erram)", () => {
    const player = mk({ name: "Hero", kind: "player", ac: 100, maxHp: 50, currentHp: 50 });
    const session = sessionWith(player, mk({ name: "Foe", kind: "enemy" }));
    const lines = resolveEnemyTurns(session, noop);
    expect(session.state.currentHp).toBe(50);
    expect(lines.every((l) => !l.includes("HP"))).toBe(true); // nenhum "X→Y HP"
    expect(session.state.combat!.active).toBe(true);
  });

  it("encerra o combate em DEFEAT quando o jogador cai — e entra em dying", () => {
    const player = mk({ name: "Hero", kind: "player", ac: 1, maxHp: 3, currentHp: 3 });
    const session = sessionWith(player, mk({ name: "Foe", kind: "enemy", level: 5 }));
    const lines = resolveEnemyTurns(session, noop);
    expect(session.state.currentHp).toBe(0);
    expect(session.state.combat!.active).toBe(false);
    expect(lines.some((l) => l.includes("DEFEAT"))).toBe(true);
    // Dying rules: cair a 0 HP = dying 1+ e inconsciente (não morte imediata).
    expect(session.state.conditions.some((c) => /^dying [12]$/.test(c))).toBe(true);
    expect(session.state.conditions).toContain("unconscious");
    expect(lines.some((l) => l.includes("DYING"))).toBe(true);
  });

  it("ignora inimigos derrotados", () => {
    const player = mk({ name: "Hero", kind: "player", ac: 1, maxHp: 200, currentHp: 200 });
    const session = sessionWith(
      player,
      mk({ name: "Dead", kind: "enemy", defeated: true }),
      mk({ name: "Live", kind: "enemy" }),
    );
    const lines = resolveEnemyTurns(session, noop);
    expect(lines.some((l) => l.includes("Dead Strike"))).toBe(false);
    expect(lines.filter((l) => l.includes("Live Strike")).length).toBe(2);
  });

  it("iniciativa estrita: inimigos mais lentos agem antes; mais rápidos por último", () => {
    const player = mk({ name: "Hero", kind: "player", ac: 100, initiative: 15 });
    const session = sessionWith(
      player,
      mk({ name: "Fast", kind: "enemy", initiative: 25 }), // mais rápido que o jogador
      mk({ name: "Slow", kind: "enemy", initiative: 5 }), // mais lento
    );
    const lines = resolveEnemyTurns(session, noop);
    const firstSlow = lines.findIndex((l) => l.includes("Slow Strike"));
    const firstFast = lines.findIndex((l) => l.includes("Fast Strike"));
    // O lento (que fecha esta rodada) aparece ANTES do rápido (que abre a próxima).
    expect(firstSlow).toBeGreaterThanOrEqual(0);
    expect(firstFast).toBeGreaterThan(firstSlow);
  });

  it("avança o round ao completar a rodada, mas não em vitória/derrota", () => {
    const alive = sessionWith(
      mk({ name: "Hero", kind: "player", ac: 100, maxHp: 50, currentHp: 50 }),
      mk({ name: "Foe", kind: "enemy" }),
    );
    expect(alive.state.combat!.round).toBe(1);
    resolveEnemyTurns(alive, noop);
    expect(alive.state.combat!.round).toBe(2); // rodada fechada → +1

    const dead = sessionWith(
      mk({ name: "Hero", kind: "player", ac: 1, maxHp: 3, currentHp: 3 }),
      mk({ name: "Foe", kind: "enemy", level: 5 }),
    );
    resolveEnemyTurns(dead, noop);
    expect(dead.state.combat!.round).toBe(1); // derrota → não avança
  });
});

// Strike de statblock real (via sourceName) — lê o dataset gerado.
describe.skipIf(!hasGenerated)("resolveEnemyTurns com bestiary (requer generated/)", () => {
  it("usa o ataque real (Jaws), MAP agile no 2º strike e dano tipado", () => {
    const player = mk({ name: "Hero", kind: "player", initiative: 20, ac: 1 }); // AC 1: sempre acerta
    const rat = mk({
      name: "Giant Rat 1",
      kind: "enemy",
      initiative: 5,
      level: -1,
      sourceName: "Giant Rat",
    });
    const s = sessionWith(player, rat);
    const lines = resolveEnemyTurns(s, noop);
    expect(lines[0]).toContain("Giant Rat 1 Jaws Strike vs Hero");
    expect(lines[0]).toContain("piercing");
    expect(lines[1]).toContain("[MAP -4 agile]");
  });

  it("inimigo sem sourceName segue no benchmark genérico", () => {
    const player = mk({ name: "Hero", kind: "player", initiative: 20, ac: 1 });
    const thug = mk({ name: "Cinzalto Thug", kind: "enemy", initiative: 5, level: 1 });
    const s = sessionWith(player, thug);
    const lines = resolveEnemyTurns(s, noop);
    expect(lines[0]).toContain("Cinzalto Thug Strike vs Hero");
    expect(lines[1]).toContain("[MAP -5]");
  });
});

describe("reactionTriggerOf (gatilhos de reação)", () => {
  it("use_item é manipulate; movimento é move; Step e rolagens não provocam", () => {
    expect(reactionTriggerOf("use_item", {})).toBe("manipulate");
    expect(reactionTriggerOf("spend_actions", { reason: "Stride to the door" })).toBe("move");
    expect(reactionTriggerOf("spend_actions", { reason: "I retreat from the fight" })).toBe("move");
    expect(reactionTriggerOf("spend_actions", { reason: "Step back carefully" })).toBeNull();
    expect(reactionTriggerOf("spend_actions", { reason: "Demoralize the goblin" })).toBeNull();
    expect(reactionTriggerOf("roll_check", {})).toBeNull();
  });
});

describe.skipIf(!hasGenerated)("triggerEnemyReactions (requer generated/)", () => {
  it("Skeletal Champion reage 1x (Reactive Strike), consome a reação e não repete", () => {
    const player = mk({ name: "Hero", kind: "player", initiative: 20 });
    const champ = mk({
      name: "Skeletal Champion",
      kind: "enemy",
      initiative: 5,
      level: 2,
      sourceName: "Skeletal Champion",
    });
    const s = sessionWith(player, champ);
    const lines = triggerEnemyReactions(s, noop);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Reaction (");
    expect(lines[0]).toContain("Skeletal Champion");
    expect(champ.reactionAvailable).toBe(false);
    // Reação já gasta: segundo gatilho na mesma rodada não faz nada.
    expect(triggerEnemyReactions(s, noop)).toEqual([]);
  });

  it("inimigo sem a reação no statblock (Giant Rat) não reage", () => {
    const player = mk({ name: "Hero", kind: "player", initiative: 20 });
    const rat = mk({
      name: "Giant Rat",
      kind: "enemy",
      initiative: 5,
      level: -1,
      sourceName: "Giant Rat",
    });
    const s = sessionWith(player, rat);
    expect(triggerEnemyReactions(s, noop)).toEqual([]);
    expect(rat.reactionAvailable).toBe(true);
  });

  it("inimigo sem sourceName (benchmark) não reage", () => {
    const player = mk({ name: "Hero", kind: "player", initiative: 20 });
    const thug = mk({ name: "Cinzalto Thug", kind: "enemy", initiative: 5, level: 1 });
    const s = sessionWith(player, thug);
    expect(triggerEnemyReactions(s, noop)).toEqual([]);
  });
});
