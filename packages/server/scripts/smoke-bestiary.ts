/**
 * Smoke test do bestiary SEM modelo/servidor/GPU: chama executeTool
 * ("start_combat") direto e imprime o roster — os stats devem ser os oficiais
 * (Giant Rat AC 15/8 HP, Goblin Warrior AC 16/6 HP) e o revide inimigo deve
 * nomear o ataque real (Jaws/Dogslicer) com MAP agile quando aplicável.
 *
 * Uso: npx tsx scripts/smoke-bestiary.ts
 */
import type { Character, Combatant } from "@pf2e/shared";
import { executeTool, resolveEnemyTurns } from "../src/gm/agent.js";
import type { Session } from "../src/gm/sessions.js";

const character = {
  name: "Smoke Hero",
  level: 1,
  maxHp: 20,
  ac: 17,
  perception: 5,
  abilityModifiers: { str: 0, dex: 3, con: 1, int: 0, wis: 1, cha: 0 },
  weapons: [{ name: "Dagger", attack: 7, die: "d4", damageBonus: 1, damageType: "P" }],
  armor: [],
  feats: [],
  classFeatures: [],
  equipment: [],
  skills: {},
  lores: [],
} as unknown as Character;

const session = {
  id: "smoke",
  character,
  state: { sessionId: "smoke", currentHp: 20, conditions: [], flags: {}, combat: null },
} as unknown as Session;

const noop = () => {};

async function main() {
  const out = await executeTool(
    session,
    "start_combat",
    {
      enemies: [
        { name: "Giant Rat", level: 3 }, // nível errado de propósito: bestiary deve vencer
        { name: "Goblin Warrior" },
        { name: "Cinzalto Enforcer", level: 1 }, // inventado: benchmark
      ],
    },
    noop,
  );
  console.log("start_combat →", out.content, "\n");

  const foes = session.state.combat!.combatants.filter(
    (c: Combatant) => c.kind === "enemy",
  );
  for (const f of foes) {
    console.log(
      `${f.name}: lvl ${f.level}, AC ${f.ac}, ${f.maxHp} HP, saves ${
        f.saves ? `F${f.saves.fortitude}/R${f.saves.reflex}/W${f.saves.will}` : "(benchmark)"
      }${f.sourceName ? ` [bestiary: ${f.sourceName}]` : ""}`,
    );
  }

  console.log("\nRevide inimigo (determinístico):");
  for (const line of resolveEnemyTurns(session, noop)) console.log(line);
}

main().catch((err) => {
  console.error("Smoke falhou:", err);
  process.exit(1);
});
