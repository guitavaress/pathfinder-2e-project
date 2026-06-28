import { Ollama, type Message, type Tool, type ToolCall } from "ollama";
import type { CheckResult, GameState } from "@pf2e/shared";
import { rollCheck } from "../dice/check.js";
import { lookupLocalRule } from "../rules/dataset.js";
import { lookupWebRule } from "../rules/web.js";
import { loadLore } from "./lore.js";
import { GM_SYSTEM_PROMPT, characterSheetBlock } from "./prompts.js";
import type { Session } from "./sessions.js";

const GM_MODEL = process.env.GM_MODEL ?? "qwen2.5:7b";
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const MAX_ITERATIONS = 8;

/** Eventos emitidos durante um turno, repassados ao cliente via SSE. */
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "check"; result: CheckResult }
  | { type: "state"; state: GameState }
  | { type: "done" }
  | { type: "error"; message: string };

const ollama = new Ollama({ host: OLLAMA_HOST });

/** Definições das ferramentas no formato OpenAI/Ollama. */
const TOOLS: Tool[] = [
  {
    type: "function",
    function: {
      name: "roll_check",
      description:
        "Rola um teste de d20 do personagem do jogador (perícia, save ou Perception) contra uma DC e retorna o grau de sucesso de PF2e. Use SEMPRE que o resultado for incerto e relevante. NUNCA escreva o resultado de um dado sem chamar esta ferramenta.",
      parameters: {
        type: "object",
        properties: {
          skill: {
            type: "string",
            description:
              "Nome do teste: uma perícia (ex.: deception, stealth, athletics), um save (fortitude, reflex, will), 'perception', ou o nome de uma Lore do personagem.",
          },
          dc: { type: "number", description: "Dificuldade (DC) do teste." },
          reason: {
            type: "string",
            description: "Descrição curta do que está sendo testado.",
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
        "Consulta o texto oficial de uma regra do PF2e por nome: ação, talento (feat), magia, condição, item/equipamento ou monstro. Use antes de aplicar uma habilidade do personagem (ex.: 'Bon Mot', 'Sneak Attack') ou uma condição (ex.: 'Frightened'). Busca no índice local e cai para o Archives of Nethys se não achar.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "O que buscar (nome da regra)." },
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
        "Retorna a ficha completa do personagem do jogador (atributos, perícias, saves).",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "update_state",
      description:
        "Registra mudanças persistentes da cena: dano/cura (hpDelta), condições e flags da história.",
      parameters: {
        type: "object",
        properties: {
          hpDelta: {
            type: "number",
            description: "Variação de HP (negativo = dano, positivo = cura).",
          },
          addConditions: { type: "array", items: { type: "string" } },
          removeConditions: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
];

/** Resolve o modificador de um teste a partir da ficha do personagem. */
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
  const partial = c.lores.find((l) => key.includes(l.name.toLowerCase()));
  return partial ? partial.modifier : null;
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
          content: `Não encontrei o teste "${skill}" na ficha. Use uma perícia, save, perception ou lore existente.`,
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
        content: `Sem entrada para "${query}" no dataset local nem no AoN. Use seu conhecimento geral de PF2e e narre de forma consistente.`,
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
      return { content: `Estado atualizado: ${JSON.stringify(s)}` };
    }
    default:
      return { content: `Ferramenta desconhecida: ${name}`, isError: true };
  }
}

/**
 * Executa um turno do jogo: adiciona a fala do jogador ao histórico, roda o
 * loop de tool use do GM (modelo local via Ollama) com streaming e atualiza a
 * sessão. Emite eventos via `emit`.
 */
export async function runTurn(
  session: Session,
  playerText: string,
  emit: (e: StreamEvent) => void,
): Promise<void> {
  session.messages.push({ role: "user", content: playerText });

  const lore = loadLore();
  const systemMessage: Message = {
    role: "system",
    content: [
      GM_SYSTEM_PROMPT,
      lore
        ? `# Cenário e diretrizes do mundo (CONHECIMENTO EXCLUSIVO DO MESTRE — nunca revele segredos diretamente ao jogador)\n${lore}`
        : "",
      characterSheetBlock(session.character),
    ]
      .filter(Boolean)
      .join("\n\n"),
  };

  console.log(`[GM] turno iniciado (modelo ${GM_MODEL})`);
  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      console.log(`[GM] iteração ${i}: chamando ollama.chat…`);
      const stream = await ollama.chat({
        model: GM_MODEL,
        messages: [systemMessage, ...session.messages],
        tools: TOOLS,
        stream: true,
        options: { num_ctx: 8192, temperature: 0.6 },
      });

      let content = "";
      const toolCalls: ToolCall[] = [];
      for await (const chunk of stream) {
        const msg = chunk.message;
        if (msg.content) {
          content += msg.content;
          emit({ type: "delta", text: msg.content });
        }
        if (msg.tool_calls?.length) toolCalls.push(...msg.tool_calls);
      }
      console.log(
        `[GM] iteração ${i}: texto=${content.length} chars, tools=[${toolCalls
          .map((t) => t.function.name)
          .join(", ")}]`,
      );

      session.messages.push({
        role: "assistant",
        content,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
      });

      if (toolCalls.length === 0) break;

      for (const tc of toolCalls) {
        const outcome = await executeTool(
          session,
          tc.function.name,
          (tc.function.arguments ?? {}) as Record<string, unknown>,
          emit,
        );
        console.log(
          `[GM]   tool ${tc.function.name}(${JSON.stringify(
            tc.function.arguments,
          )}) -> ${outcome.isError ? "ERRO: " : ""}${outcome.content.slice(0, 80)}`,
        );
        session.messages.push({
          role: "tool",
          content: outcome.content,
          tool_name: tc.function.name,
        });
      }
    }
    console.log("[GM] turno concluído");
    emit({ type: "done" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[GM] ERRO no turno:", message);
    emit({ type: "error", message });
  }
}
