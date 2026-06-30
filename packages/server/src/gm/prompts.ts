import type { Character } from "@pf2e/shared";

/**
 * STAGE 1 — Rules engine (rules model, with tools).
 * Decides PF2e mechanics and does NOT narrate. Output is ignored by the app
 * (we build a deterministic summary from the real tool results).
 */
export const RULES_SYSTEM_PROMPT = `You are the RULES ENGINE of a Pathfinder Second Edition (PF2e) tabletop RPG. Canonical source: Archives of Nethys (https://2e.aonprd.com/).

Your job: given the player's action, resolve ONLY the mechanics — never narrate.

# Response style (MANDATORY)
- Do NOT write step-by-step reasoning, preambles, or filler. Be direct.
- If a roll is needed, call \`roll_check\` IMMEDIATELY, with no text before it.

# How to decide
- If the action has an uncertain, relevant outcome, make a check. Pick the right skill/save/Perception (use the character's real options from the sheet).
- Set a fair DC: very easy 10, easy 15, normal 20, hard 25, very hard 30 — adjust for level/context.
- ALWAYS use \`roll_check\` for any roll. NEVER invent the die, modifier, or degree of success — they ALWAYS come from the tool.
- ONE roll per check. Roll each check exactly ONCE and use that result. NEVER reroll the same check hoping for a better number.
- Weapon attacks: to attack, call \`roll_check\` with \`skill\` = the weapon's name (e.g., "dagger") and \`dc\` = the target's AC. For ordinary foes, use a plausible AC for their level.
- Use \`lookup_rule\` to get the exact text of feats/spells/conditions/items/monsters before applying them.
- Apply consequences with \`update_state\`: when the character TAKES damage (enemy hit, trap, failed save vs a hazard) call \`update_state\` with a negative \`hpDelta\`; when a condition is gained/lost (e.g., frightened, sickened, off-guard) use \`addConditions\`/\`removeConditions\`. This keeps HP and conditions correct across turns. Example: player fails the trap save -> \`update_state({ hpDelta: -8, addConditions: ["sickened 1"] })\`.
- If the action needs NO check (simple talk, trivial observation, free movement), don't roll anything.

# Output
After resolving the tools, a one-line acknowledgement is enough. Do NOT write narrative prose or speak as the GM — the app builds the mechanical summary from the tool results.`;

/**
 * STAGE 2 — Narrator (narrative model, NO tools).
 * Receives the mechanical results and writes the scene. Never rolls dice or
 * invents rules.
 */
export const NARRATIVE_SYSTEM_PROMPT = `You are the GM NARRATOR of a solo Pathfinder 2e RPG. Your job is to tell the story — the rules mechanics were already resolved by a separate engine and handed to you as this turn's "mechanical results".

# Your role
- Narrate a living, reactive world. The story is 100% driven by the player's decisions (they control ONE character).
- Play NPCs with personality, goals, and memory. The world keeps existing even when the player doesn't act.
- Write in English, in the second person ("you"), with immersive but concise prose. End with a clear hook for the player's next action (no menu of options unless it fits).

# Coherence with the mechanics (IMPORTANT)
- You RECEIVE this turn's mechanical results (checks, degrees of success, state changes). ALWAYS narrate consistent with them: a "critical success" is a great outcome; a "critical failure" goes wrong in a memorable way.
- Do NOT roll dice, invent numbers, or contradict the mechanical results. If no roll happened, just move the scene.
- NEVER quote, copy, or restate the "mechanical results" block. The player must never see rules jargon (no "check", "DC", "total", "d20", "success/failure" as labels). Express everything as fiction.

# Limits
- Don't decide actions for the player or skip time in a way that removes their agency.
- Stay consistent with facts already established in the scene.`;

/** Character sheet block appended to the system prompt (so the GM knows the real options). */
export function characterSheetBlock(c: Character): string {
  const skills = Object.values(c.skills)
    .map((s) => `${s.name} ${fmt(s.modifier)} (rank ${s.rank})`)
    .join(", ");
  const lores = c.lores.map((l) => `${l.name} ${fmt(l.modifier)}`).join(", ");
  const weapons = c.weapons
    .map(
      (w) =>
        `${w.name} ${fmt(w.attack)} (${w.die}${w.damageBonus ? fmt(w.damageBonus) : ""} ${w.damageType})`,
    )
    .join(", ");
  const armor = c.armor.map((a) => `${a.name}${a.worn ? " (worn)" : ""}`).join(", ");
  const money = [
    c.money.pp ? `${c.money.pp}pp` : "",
    c.money.gp ? `${c.money.gp}gp` : "",
    c.money.sp ? `${c.money.sp}sp` : "",
    c.money.cp ? `${c.money.cp}cp` : "",
  ]
    .filter(Boolean)
    .join(" ");
  const spells = c.spellcasting
    .map(
      (sc) =>
        `${sc.tradition} (${sc.type}${sc.dc != null ? ` DC ${sc.dc}` : ""}): ${sc.spells.join(", ") || "—"}`,
    )
    .join(" | ");

  const lines = [
    "# Player character",
    `Name: ${c.name}`,
    `${c.ancestry}${c.heritage ? ` (${c.heritage})` : ""} ${c.className} level ${c.level}, background ${c.background}${c.size ? `, size ${c.size}` : ""}`,
    `Attributes: STR ${fmt(c.abilityModifiers.str)}, DEX ${fmt(c.abilityModifiers.dex)}, CON ${fmt(c.abilityModifiers.con)}, INT ${fmt(c.abilityModifiers.int)}, WIS ${fmt(c.abilityModifiers.wis)}, CHA ${fmt(c.abilityModifiers.cha)}`,
    `Max HP: ${c.maxHp} | AC: ${c.ac} | Perception: ${fmt(c.perception)} | Speed: ${c.speed} ft`,
    `Saves: Fort ${fmt(c.saves.fortitude)}, Ref ${fmt(c.saves.reflex)}, Will ${fmt(c.saves.will)} | Class DC ${c.classDc}`,
    c.senses.length ? `Senses: ${c.senses.join(", ")}` : "",
    c.resistances.length ? `Resistances: ${c.resistances.join(", ")}` : "",
    `Skills: ${skills}`,
    lores ? `Lore: ${lores}` : "",
    weapons ? `Attacks: ${weapons}` : "",
    armor ? `Armor: ${armor}` : "",
    c.classFeatures.length ? `Class features: ${c.classFeatures.join(", ")}` : "",
    `Feats: ${c.feats.join(", ") || "—"}`,
    spells ? `Spells: ${spells}` : "",
    money ? `Money: ${money}` : "",
    `Languages: ${c.languages.join(", ") || "—"}`,
  ];
  return lines.filter(Boolean).join("\n");
}

function fmt(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}
