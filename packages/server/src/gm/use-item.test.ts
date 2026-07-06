import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Character, Combatant } from "@pf2e/shared";
import { executeTool } from "./agent.js";
import { buildCombat } from "./combat.js";
import type { Session } from "./sessions.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));

const noop = () => {};

function mkCharacter(equipment: [string, number][]): Character {
  return {
    name: "Hero",
    level: 5,
    maxHp: 50,
    ac: 20,
    perception: 10,
    abilityModifiers: { str: 0, dex: 4, con: 2, int: 0, wis: 1, cha: 0 },
    weaponProficiencies: { simple: 2, martial: 2 },
    weapons: [{ name: "Dagger", attack: 13, die: "d4", damageBonus: 0, damageType: "P" }],
    armor: [],
    feats: [],
    classFeatures: [],
    equipment: equipment.map(([name, qty]) => ({ name, qty })),
    skills: {},
    lores: [],
  } as unknown as Character;
}

function mkSession(
  equipment: [string, number][],
  opts: { combat?: boolean; currentHp?: number } = {},
): Session {
  const character = mkCharacter(equipment);
  const player: Combatant = {
    id: "hero",
    name: "Hero",
    kind: "player",
    initiative: 20,
    ac: 20,
    maxHp: 50,
    currentHp: opts.currentHp ?? 50,
    conditions: [],
    actionsRemaining: 3,
    reactionAvailable: true,
    mapProgress: 0,
    level: 5,
    traits: [],
    defeated: false,
  };
  const rat: Combatant = { ...player, id: "rat", name: "Giant Rat", kind: "enemy", ac: 1, maxHp: 40, currentHp: 40 };
  return {
    id: "t",
    character,
    state: {
      sessionId: "t",
      currentHp: opts.currentHp ?? 50,
      conditions: [],
      flags: {},
      combat: opts.combat ? buildCombat([player, rat]) : null,
    },
  } as unknown as Session;
}

describe.skipIf(!hasGenerated)("use_item (requer generated/)", () => {
  it("rejeita item que não está no Equipment (mão vazia)", async () => {
    const s = mkSession([["Rope", 1]]);
    const out = await executeTool(s, "use_item", { item: "Healing Potion", reason: "drink" }, noop);
    expect(out.isError).toBe(true);
    expect(out.summaryLine).toContain("hand finds nothing");
  });

  it("poção de cura: rola o dado REAL do item, capa em maxHp e decrementa", async () => {
    const s = mkSession([["Healing Potion (Minor)", 2]], { currentHp: 40 });
    const out = await executeTool(s, "use_item", { item: "Healing Potion (Minor)", reason: "drink it" }, noop);
    expect(out.isError).toBeUndefined();
    // Minor = 1d8: cura 1-8, partindo de 40/50 (nunca passa de 50).
    expect(s.state.currentHp).toBeGreaterThanOrEqual(41);
    expect(s.state.currentHp).toBeLessThanOrEqual(48);
    expect(s.character.equipment.find((e) => /healing potion/i.test(e.name))?.qty).toBe(1);

    // Segunda poção: some do inventário.
    await executeTool(s, "use_item", { item: "healing potion", reason: "drink" }, noop);
    expect(s.character.equipment.some((e) => /healing potion/i.test(e.name))).toBe(false);

    // Terceira: rejeitada — o contador é da engine, não do modelo.
    const third = await executeTool(s, "use_item", { item: "healing potion", reason: "drink" }, noop);
    expect(third.isError).toBe(true);
  });

  it("bomba: Strike com o statblock REAL (1d8 fire + splash + persistent), consome mesmo errando", async () => {
    const s = mkSession([["Alchemist's Fire (Lesser)", 1]], { combat: true });
    const out = await executeTool(
      s,
      "use_item",
      { item: "Alchemist's Fire", target: "Giant Rat", reason: "throw the flask" },
      noop,
    );
    expect(out.isError).toBeUndefined();
    const payload = JSON.parse(out.content) as { hit: boolean; crit: boolean; damage: number };
    // AC 1 e bônus alto: sempre acerta.
    expect(payload.hit).toBe(true);
    // 1d8 (+dobro no crit) + 1 splash → 2..17; tipo fire no summary.
    expect(payload.damage).toBeGreaterThanOrEqual(2);
    expect(payload.damage).toBeLessThanOrEqual(17);
    expect(out.summaryLine).toContain("fire");
    const rat = s.state.combat!.combatants.find((c) => c.id === "rat")!;
    expect(rat.currentHp).toBe(40 - payload.damage);
    expect(rat.conditions).toContain("persistent fire damage 1");
    // Consumiu a única bomba e cobrou 2 ações (draw + throw).
    expect(s.character.equipment.some((e) => /alchemist/i.test(e.name))).toBe(false);
    const you = s.state.combat!.combatants.find((c) => c.kind === "player")!;
    expect(you.actionsRemaining).toBe(1);
    expect(you.mapProgress).toBe(1);
  });

  it("bomba fora de combate / sem target → erro educativo, nada consumido", async () => {
    const s = mkSession([["Alchemist's Fire (Lesser)", 1]]);
    const out = await executeTool(s, "use_item", { item: "Alchemist's Fire", reason: "throw" }, noop);
    expect(out.isError).toBe(true);
    expect(s.character.equipment.some((e) => /alchemist/i.test(e.name))).toBe(true);
  });

  it("item não-consumível (Rope) NÃO decrementa", async () => {
    const s = mkSession([["Rope", 1]]);
    const out = await executeTool(s, "use_item", { item: "Rope", reason: "tie a knot" }, noop);
    expect(out.isError).toBeUndefined();
    expect(s.character.equipment.find((e) => e.name === "Rope")?.qty).toBe(1);
  });

  it("em combate sem ações suficientes → ILLEGAL, nada consumido", async () => {
    const s = mkSession([["Healing Potion (Minor)", 1]], { combat: true });
    const you = s.state.combat!.combatants.find((c) => c.kind === "player")!;
    you.actionsRemaining = 1; // precisa de 2
    const out = await executeTool(s, "use_item", { item: "Healing Potion (Minor)", reason: "drink" }, noop);
    expect(out.isError).toBe(true);
    expect(s.character.equipment[0]!.qty).toBe(1);
  });
});
