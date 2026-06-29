import { Ollama, type Message, type Tool, type ToolCall } from "ollama";
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

/** Modelo que resolve as REGRAS/ferramentas (etapa 1). */
export const RULES_MODEL = process.env.RULES_MODEL ?? "qwen3:30b-a3b";
/** Modelo que escreve a NARRATIVA (etapa 2). */
export const NARRATIVE_MODEL = process.env.NARRATIVE_MODEL ?? "gemma3:27b";
const OLLAMA_HOST = process.env.OLLAMA_HOST ?? "http://localhost:11434";
const MAX_ITERATIONS = 8;
/** Quantas mensagens recentes do histórico a etapa de regras enxerga como contexto. */
const RULES_CONTEXT_TURNS = 6;

/** Eventos emitidos durante um turno, repassados ao cliente via SSE. */
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "check"; result: CheckResult }
  | { type: "state"; state: GameState }
  | { type: "phase"; phase: "rules" | "narrative" }
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
        "Rola UMA vez um d20 do personagem contra uma DC e retorna o grau de sucesso de PF2e. Use para perícias, saves, Perception e ATAQUES DE ARMA. Cada teste é rolado UMA única vez por turno — não repita a mesma rolagem. NUNCA escreva o resultado de um dado sem chamar esta ferramenta.",
      parameters: {
        type: "object",
        properties: {
          skill: {
            type: "string",
            description:
              "O que rolar: uma perícia (ex.: deception, stealth, athletics), um save (fortitude, reflex, will), 'perception', o nome de uma Lore, ou — para um ATAQUE — o nome da arma do personagem (ex.: 'dagger'). Para ataques, a 'dc' é a CA do alvo.",
          },
          dc: {
            type: "number",
            description: "Dificuldade (DC) do teste — ou a CA do alvo, em ataques.",
          },
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
  const lorePartial = c.lores.find((l) => key.includes(l.name.toLowerCase()));
  if (lorePartial) return lorePartial.modifier;
  // Ataques de arma: usa o bônus de ataque já calculado da arma (vs CA do alvo).
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
 * ETAPA 1 — Regras: o modelo de regras resolve a mecânica via tool use (sem
 * narrar). Emite eventos `check`/`state`, NÃO emite `delta`. Roda num histórico
 * de mensagens próprio (não polui o diálogo narrativo) e retorna o resumo mecânico.
 */
async function runRulesStage(
  session: Session,
  emit: (e: StreamEvent) => void,
): Promise<string> {
  const rulesSystem: Message = {
    role: "system",
    content: `${RULES_SYSTEM_PROMPT}\n\n${characterSheetBlock(session.character)}`,
  };
  // Contexto: as mensagens recentes do diálogo (terminando na ação do jogador).
  const messages: Message[] = [
    rulesSystem,
    ...session.messages.slice(-RULES_CONTEXT_TURNS),
  ];

  // Coletamos os RESULTADOS reais das ferramentas e montamos o resumo no código
  // (determinístico, em PT, conciso) — a prosa do modelo de regras é ignorada.
  const checks: CheckResult[] = [];
  const consulted: string[] = [];
  let anyTool = false;
  // Anti-spam: o modelo às vezes rola o MESMO teste várias vezes no turno.
  // Cacheamos por (perícia|motivo) e reusamos o 1º resultado (sem novo card).
  const rollCache = new Map<string, ToolOutcome>();

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    const stream = await ollama.chat({
      model: RULES_MODEL,
      messages,
      tools: TOOLS,
      stream: true,
      think: false,
      options: { num_ctx: 8192, temperature: 0.3 },
    });

    let content = "";
    const toolCalls: ToolCall[] = [];
    for await (const chunk of stream) {
      const msg = chunk.message;
      if (msg.content) content += msg.content; // NÃO emitir delta na etapa de regras
      if (msg.tool_calls?.length) toolCalls.push(...msg.tool_calls);
    }
    console.log(
      `[GM][regras] iter ${i}: texto=${content.length} chars, tools=[${toolCalls
        .map((t) => t.function.name)
        .join(", ")}]`,
    );

    messages.push({
      role: "assistant",
      content,
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });

    if (toolCalls.length === 0) break;
    anyTool = true;

    for (const tc of toolCalls) {
      const args = (tc.function.arguments ?? {}) as Record<string, unknown>;
      let outcome: ToolOutcome;

      if (tc.function.name === "roll_check") {
        const key = `${String(args.skill ?? "")}|${String(args.reason ?? "")}`
          .toLowerCase()
          .trim();
        const cached = rollCache.get(key);
        if (cached) {
          outcome = cached; // rolagem repetida no mesmo turno → reusa (sem rolar/emitir de novo)
          console.log(`[GM][regras]   roll_check repetido ignorado (${key})`);
        } else {
          outcome = await executeTool(session, "roll_check", args, emit);
          console.log(
            `[GM][regras]   tool roll_check(${JSON.stringify(args)}) -> ${
              outcome.isError ? "ERRO: " : ""
            }${outcome.content.slice(0, 80)}`,
          );
          if (!outcome.isError) {
            rollCache.set(key, outcome); // só cacheia rolagens válidas
            try {
              checks.push(JSON.parse(outcome.content) as CheckResult);
            } catch {
              // ignora conteúdo não-JSON
            }
          }
        }
      } else {
        outcome = await executeTool(session, tc.function.name, args, emit);
        console.log(
          `[GM][regras]   tool ${tc.function.name}(${JSON.stringify(args)}) -> ${
            outcome.isError ? "ERRO: " : ""
          }${outcome.content.slice(0, 80)}`,
        );
        if (tc.function.name === "lookup_rule" && !outcome.isError) {
          consulted.push(outcome.content.split("\n")[0]!.slice(0, 80));
        }
      }

      messages.push({
        role: "tool",
        content: outcome.content,
        tool_name: tc.function.name,
      });
    }
  }

  return buildMechanicalSummary(session, checks, consulted, anyTool);
}

const DEGREE_PT: Record<CheckResult["degree"], string> = {
  criticalSuccess: "sucesso crítico",
  success: "sucesso",
  failure: "falha",
  criticalFailure: "falha crítica",
};

/** Monta um resumo mecânico curto e factual a partir dos resultados das ferramentas. */
function buildMechanicalSummary(
  session: Session,
  checks: CheckResult[],
  consulted: string[],
  anyTool: boolean,
): string {
  if (checks.length === 0 && consulted.length === 0 && !anyTool) {
    return "Sem teste necessário.";
  }
  const lines: string[] = [];
  for (const c of checks) {
    lines.push(`Teste: ${c.label} → ${DEGREE_PT[c.degree]} (total ${c.total}).`);
  }
  if (consulted.length) {
    lines.push(`Regras consultadas: ${consulted.join("; ")}.`);
  }
  const st = session.state;
  const cond = st.conditions.length
    ? `, condições: ${st.conditions.join(", ")}`
    : "";
  lines.push(`Estado: HP ${st.currentHp}/${session.character.maxHp}${cond}.`);
  return lines.join("\n");
}

/**
 * ETAPA 2 — Narrativa: o modelo de narrativa escreve a cena (com streaming),
 * coerente com o resumo mecânico. Sem ferramentas. Anexa a narração ao histórico.
 */
async function runNarrativeStage(
  session: Session,
  mechanical: string,
  emit: (e: StreamEvent) => void,
): Promise<void> {
  const lore = loadLore();
  const narrativeSystem: Message = {
    role: "system",
    content: [
      NARRATIVE_SYSTEM_PROMPT,
      lore
        ? `# Cenário e diretrizes do mundo (CONHECIMENTO EXCLUSIVO DO MESTRE — nunca revele segredos diretamente ao jogador)\n${lore}`
        : "",
      characterSheetBlock(session.character),
      mechanical
        ? `# Dados mecânicos deste turno (REFERÊNCIA INTERNA — NÃO copie nem cite estes termos na narração; traduza em ficção)\n${mechanical}`
        : "# Dados mecânicos deste turno\nNenhum teste necessário; conduza a cena livremente.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  };

  // Sem `think`: gemma3 não suporta thinking (e o Ollama erra se for passado).
  const stream = await ollama.chat({
    model: NARRATIVE_MODEL,
    messages: [narrativeSystem, ...session.messages],
    stream: true,
    options: { num_ctx: 8192, temperature: 0.7 },
  });

  let narration = "";
  for await (const chunk of stream) {
    const msg = chunk.message;
    if (msg.content) {
      narration += msg.content;
      emit({ type: "delta", text: msg.content });
    }
  }
  session.messages.push({ role: "assistant", content: narration });
}

/**
 * Executa um turno em duas etapas: (1) o modelo de regras resolve a mecânica
 * PF2e via ferramentas; (2) o modelo de narrativa escreve a cena coerente com
 * o resultado, em streaming. Emite eventos via `emit`.
 */
export async function runTurn(
  session: Session,
  playerText: string,
  emit: (e: StreamEvent) => void,
): Promise<void> {
  session.messages.push({ role: "user", content: playerText });
  console.log(
    `[GM] turno iniciado (regras=${RULES_MODEL}, narrativa=${NARRATIVE_MODEL})`,
  );
  try {
    emit({ type: "phase", phase: "rules" });
    const mechanical = await runRulesStage(session, emit);
    console.log(`[GM] resumo mecânico: ${mechanical.slice(0, 160) || "(vazio)"}`);

    emit({ type: "phase", phase: "narrative" });
    await runNarrativeStage(session, mechanical, emit);

    console.log("[GM] turno concluído");
    emit({ type: "done" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[GM] ERRO no turno:", message);
    emit({ type: "error", message });
  }
}
