import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { CheckResult, GameState } from "@pf2e/shared";
import { rollCheck } from "../dice/check.js";
import { lookupLocalRule } from "../rules/dataset.js";
import { lookupWebRule } from "../rules/web.js";
import { loadLore } from "./lore.js";
import {
  NARRATIVE_SYSTEM_PROMPT,
  RULES_SYSTEM_PROMPT,
  characterSheetBlock,
} from "./prompts.js";
import type { Session } from "./sessions.js";

/** Model that resolves the RULES/tools (stage 1). */
export const RULES_MODEL = process.env.RULES_MODEL ?? "qwen/qwen3-30b-a3b";
/** Model that writes the NARRATIVE (stage 2). */
export const NARRATIVE_MODEL = process.env.NARRATIVE_MODEL ?? "google/gemma-3-27b";
/** LM Studio's OpenAI-compatible base URL (the server runs locally on :1234). */
const LMSTUDIO_BASE_URL =
  process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1";
const MAX_ITERATIONS = 8;
/** How many recent history messages the rules stage sees as context. */
const RULES_CONTEXT_TURNS = 6;

/** Events emitted during a turn, forwarded to the client via SSE. */
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "check"; result: CheckResult }
  | { type: "state"; state: GameState }
  | { type: "phase"; phase: "rules" | "narrative" }
  | { type: "done" }
  | { type: "error"; message: string };

// LM Studio ignores the API key, but the OpenAI SDK requires a non-empty one.
const client = new OpenAI({ baseURL: LMSTUDIO_BASE_URL, apiKey: "lm-studio" });

/** Tool definitions in the OpenAI function-calling format. */
const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "roll_check",
      description:
        "Rolls the character's d20 ONCE against a DC and returns the PF2e degree of success. Use for skills, saves, Perception, and WEAPON ATTACKS. Each check is rolled exactly ONCE per turn — do not repeat the same roll. NEVER state a die result without calling this tool.",
      parameters: {
        type: "object",
        properties: {
          skill: {
            type: "string",
            description:
              "What to roll: a skill (e.g. deception, stealth, athletics), a save (fortitude, reflex, will), 'perception', a Lore name, or — for an ATTACK — the character's weapon name (e.g. 'dagger'). For attacks, 'dc' is the target's AC.",
          },
          dc: {
            type: "number",
            description: "The check's DC — or the target's AC for attacks.",
          },
          reason: {
            type: "string",
            description: "Short description of what is being attempted.",
          },
        },
        required: ["skill", "dc", "reason"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_rule",
      description:
        "Looks up the official text of a PF2e rule by name: action, feat, spell, condition, item/equipment, or monster. Use before applying one of the character's abilities (e.g. 'Bon Mot', 'Sneak Attack') or a condition (e.g. 'Frightened'). Searches the local index, falling back to Archives of Nethys if not found.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look up (the rule's name)." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_character",
      description:
        "Returns the player character's full sheet (attributes, skills, saves).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "update_state",
      description:
        "Records persistent scene changes: damage/healing (hpDelta) and conditions gained/removed.",
      parameters: {
        type: "object",
        properties: {
          hpDelta: {
            type: "number",
            description: "HP change (negative = damage, positive = healing).",
          },
          addConditions: { type: "array", items: { type: "string" } },
          removeConditions: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
];

/** Resolves a check's modifier from the character sheet. */
function resolveModifier(session: Session, skillRaw: string): number | null {
  const key = skillRaw.toLowerCase().trim();
  const c = session.character;
  if (key === "perception") return c.perception;
  if (key === "fortitude" || key === "fort") return c.saves.fortitude;
  if (key === "reflex" || key === "ref") return c.saves.reflex;
  if (key === "will") return c.saves.will;
  if (c.skills[key]) return c.skills[key]!.modifier;
  const lore = c.lores.find((l) => l.name.toLowerCase() === key);
  if (lore) return lore.modifier;
  const lorePartial = c.lores.find((l) => key.includes(l.name.toLowerCase()));
  if (lorePartial) return lorePartial.modifier;
  // Weapon attacks: use the weapon's precomputed attack bonus (vs target AC).
  const weapon =
    c.weapons.find((w) => w.name.toLowerCase() === key) ??
    c.weapons.find((w) => key.includes(w.name.toLowerCase()));
  if (weapon) return weapon.attack;
  if (
    (key === "attack" || key === "strike" || key === "ataque" || key === "unarmed") &&
    c.weapons[0]
  ) {
    return c.weapons[0].attack;
  }
  return null;
}

interface ToolOutcome {
  content: string;
  isError?: boolean;
}

async function executeTool(
  session: Session,
  name: string,
  input: Record<string, unknown>,
  emit: (e: StreamEvent) => void,
): Promise<ToolOutcome> {
  switch (name) {
    case "roll_check": {
      const skill = String(input.skill ?? "");
      const dc = Number(input.dc ?? 0);
      const reason = String(input.reason ?? skill);
      const modifier = resolveModifier(session, skill);
      if (modifier === null) {
        return {
          content: `No check named "${skill}" on the sheet. Use an existing skill, save, perception, lore, or weapon name.`,
          isError: true,
        };
      }
      const result = rollCheck(`${reason} (${skill} vs DC ${dc})`, modifier, dc);
      emit({ type: "check", result });
      return { content: JSON.stringify(result) };
    }
    case "lookup_rule": {
      const query = String(input.query ?? "");
      const local = lookupLocalRule(query);
      if (local) {
        const traits = local.traits?.length ? ` [${local.traits.join(", ")}]` : "";
        return {
          content: `${local.name} (${local.category})${traits}\n${local.text}`,
        };
      }
      const web = await lookupWebRule(query);
      if (web) {
        return {
          content: `[Archives of Nethys: ${web.url}]\n${web.name} (${web.category}): ${web.text}`,
        };
      }
      return {
        content: `No entry for "${query}" in the local dataset or AoN. Use your general PF2e knowledge and stay consistent.`,
      };
    }
    case "get_character": {
      return { content: characterSheetBlock(session.character) };
    }
    case "update_state": {
      const s = session.state;
      if (typeof input.hpDelta === "number") {
        s.currentHp = Math.max(
          0,
          Math.min(session.character.maxHp, s.currentHp + input.hpDelta),
        );
      }
      if (Array.isArray(input.addConditions)) {
        for (const cond of input.addConditions as string[]) {
          if (!s.conditions.includes(cond)) s.conditions.push(cond);
        }
      }
      if (Array.isArray(input.removeConditions)) {
        const remove = new Set(input.removeConditions as string[]);
        s.conditions = s.conditions.filter((c) => !remove.has(c));
      }
      emit({ type: "state", state: s });
      return { content: `State updated: ${JSON.stringify(s)}` };
    }
    default:
      return { content: `Unknown tool: ${name}`, isError: true };
  }
}

/**
 * STAGE 1 — Rules: the rules model resolves the mechanics via tool use (no
 * narration). Emits `check`/`state` events but NOT `delta`. Runs on its own
 * message history (doesn't pollute the narrative dialogue) and returns the
 * mechanical summary.
 */
async function runRulesStage(
  session: Session,
  emit: (e: StreamEvent) => void,
): Promise<string> {
  // Context: the recent dialogue messages (ending on the player's action).
  const messages: ChatCompletionMessageParam[] = [
    {
      role: "system",
      content: `${RULES_SYSTEM_PROMPT}\n\n${characterSheetBlock(session.character)}`,
    },
    ...session.messages.slice(-RULES_CONTEXT_TURNS),
  ];

  // We collect the REAL tool results and build the summary in code
  // (deterministic, concise) — the rules model's prose is ignored.
  const checks: CheckResult[] = [];
  const consulted: string[] = [];
  let anyTool = false;
  // Anti-spam: the model sometimes rolls the SAME check several times per turn.
  // We cache by (skill|reason) and reuse the 1st result (no new card).
  const rollCache = new Map<string, ToolOutcome>();

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    // The rules stage doesn't stream to the client (no delta events), so a
    // single non-streaming completion keeps the tool_calls easy to read.
    const resp = await client.chat.completions.create({
      model: RULES_MODEL,
      messages,
      tools: TOOLS,
      temperature: 0.3,
    });
    const message = resp.choices[0]?.message;
    const toolCalls = message?.tool_calls ?? [];
    console.log(
      `[GM][rules] iter ${i}: text=${message?.content?.length ?? 0} chars, tools=[${toolCalls
        .map((t) => t.function.name)
        .join(", ")}]`,
    );

    // Push the assistant message verbatim (it carries the tool_calls + ids).
    if (message) messages.push(message);

    if (toolCalls.length === 0) break;
    anyTool = true;

    for (const tc of toolCalls) {
      const args = parseToolArgs(tc.function.arguments);
      let outcome: ToolOutcome;

      if (tc.function.name === "roll_check") {
        const key = `${String(args.skill ?? "")}|${String(args.reason ?? "")}`
          .toLowerCase()
          .trim();
        const cached = rollCache.get(key);
        if (cached) {
          outcome = cached; // repeated roll this turn → reuse (don't roll/emit again)
          console.log(`[GM][rules]   duplicate roll_check ignored (${key})`);
        } else {
          outcome = await executeTool(session, "roll_check", args, emit);
          console.log(
            `[GM][rules]   tool roll_check(${JSON.stringify(args)}) -> ${
              outcome.isError ? "ERROR: " : ""
            }${outcome.content.slice(0, 80)}`,
          );
          if (!outcome.isError) {
            rollCache.set(key, outcome); // only cache valid rolls
            try {
              checks.push(JSON.parse(outcome.content) as CheckResult);
            } catch {
              // ignore non-JSON content
            }
          }
        }
      } else {
        outcome = await executeTool(session, tc.function.name, args, emit);
        console.log(
          `[GM][rules]   tool ${tc.function.name}(${JSON.stringify(args)}) -> ${
            outcome.isError ? "ERROR: " : ""
          }${outcome.content.slice(0, 80)}`,
        );
        if (tc.function.name === "lookup_rule" && !outcome.isError) {
          consulted.push(outcome.content.split("\n")[0]!.slice(0, 80));
        }
      }

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: outcome.content,
      });
    }
  }

  return buildMechanicalSummary(session, checks, consulted, anyTool);
}

/** OpenAI returns tool-call arguments as a JSON string; parse defensively. */
function parseToolArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

const DEGREE_EN: Record<CheckResult["degree"], string> = {
  criticalSuccess: "critical success",
  success: "success",
  failure: "failure",
  criticalFailure: "critical failure",
};

/** Strips the "(skill vs DC n)" suffix so only the plain reason remains. */
function checkReason(label: string): string {
  return label.split(" (")[0]!.trim();
}

/**
 * Builds a short, player-safe mechanical summary from the tool results. It
 * deliberately omits rules jargon (no "DC", "total", or die numbers) so that
 * if the narrative model leaks this block verbatim, nothing breaks immersion.
 */
function buildMechanicalSummary(
  session: Session,
  checks: CheckResult[],
  consulted: string[],
  anyTool: boolean,
): string {
  if (checks.length === 0 && consulted.length === 0 && !anyTool) {
    return "No roll was needed this turn.";
  }
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`- ${checkReason(c.label)}: ${DEGREE_EN[c.degree]}.`);
  }
  if (consulted.length) {
    lines.push(`Rules consulted: ${consulted.join("; ")}.`);
  }
  const st = session.state;
  const cond = st.conditions.length
    ? `, conditions: ${st.conditions.join(", ")}`
    : "";
  lines.push(`State: HP ${st.currentHp}/${session.character.maxHp}${cond}.`);
  return lines.join("\n");
}

/**
 * STAGE 2 — Narrative: the narrative model writes the scene (streaming),
 * consistent with the mechanical summary. No tools. Appends the narration to
 * the history.
 */
async function runNarrativeStage(
  session: Session,
  mechanical: string,
  emit: (e: StreamEvent) => void,
): Promise<void> {
  const lore = loadLore();
  const narrativeSystem: ChatCompletionMessageParam = {
    role: "system",
    content: [
      NARRATIVE_SYSTEM_PROMPT,
      lore
        ? `# World setting and guidelines (GM-ONLY KNOWLEDGE — never reveal secrets directly to the player)\n${lore}`
        : "",
      characterSheetBlock(session.character),
      mechanical
        ? `# Mechanical results for this turn (INTERNAL REFERENCE — do NOT copy or quote these terms in the narration; translate them into fiction)\n${mechanical}`
        : "# Mechanical results for this turn\nNo roll was needed; move the scene freely.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };

  const stream = await client.chat.completions.create({
    model: NARRATIVE_MODEL,
    messages: [narrativeSystem, ...session.messages],
    stream: true,
    temperature: 0.7,
  });

  let narration = "";
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content;
    if (delta) {
      narration += delta;
      emit({ type: "delta", text: delta });
    }
  }
  session.messages.push({ role: "assistant", content: narration });
}

/**
 * Runs a turn in two stages: (1) the rules model resolves the PF2e mechanics
 * via tools; (2) the narrative model writes the scene consistent with the
 * result, streaming. Emits events via `emit`.
 */
export async function runTurn(
  session: Session,
  playerText: string,
  emit: (e: StreamEvent) => void,
): Promise<void> {
  session.messages.push({ role: "user", content: playerText });
  console.log(
    `[GM] turn started (rules=${RULES_MODEL}, narrative=${NARRATIVE_MODEL})`,
  );
  try {
    emit({ type: "phase", phase: "rules" });
    const mechanical = await runRulesStage(session, emit);
    console.log(`[GM] mechanical summary: ${mechanical.slice(0, 160) || "(empty)"}`);

    emit({ type: "phase", phase: "narrative" });
    await runNarrativeStage(session, mechanical, emit);

    console.log("[GM] turn finished");
    emit({ type: "done" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[GM] turn ERROR:", message);
    emit({ type: "error", message });
  }
}
