/**
 * Bench do teto de vozes (T5 da Fase 2, ADR-004).
 *
 * Mede o VAZAMENTO DE VOZ do narrador com 1/2/3/4 personas de companheiro no
 * contexto: em cada turno o gate real (`pickVoice`/`voiceDirective`) decide
 * quem pode falar; o juiz então verifica na narração (a) se companheiro mudo
 * ganhou fala, (b) se o marcador verbal de uma persona muda vazou em fala
 * alheia, (c) se o escolhido de fato falou e na voz certa.
 *
 * Cada persona tem um MARCADOR verbal único ("cub", "aye", "fascinating",
 * "by the Lady") — detecção determinística, sem juiz-LLM. O histórico-semente
 * apresenta TODAS as vozes uma vez (cenário realista: numa campanha todo
 * companheiro já falou antes), e o bench mede os turnos seguintes.
 *
 * Uso:  npx tsx scripts/voice-bench/run-voice-bench.ts [--sizes=1,2,3,4]
 * Saída: report-<data>.md + transcripts/ neste diretório.
 */
import "dotenv/config";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Companion } from "@pf2e/shared";
import { BANTER_EVERY, pickVoice, voiceDirective } from "../../src/gm/voice-gate.js";
import { NARRATIVE_SYSTEM_PROMPT } from "../../src/gm/prompts.js";

const here = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.LLM_BASE_URL ?? "http://127.0.0.1:1234/v1";
const MODEL = process.env.NARRATIVE_MODEL ?? process.env.GM_MODEL ?? "local";
const SIZES = (process.argv.find((a) => a.startsWith("--sizes="))?.split("=")[1] ?? "1,2,3,4")
  .split(",")
  .map(Number);

// Mesmos samplers fixados no agent.ts (a doutrina vale para o bench: medir com
// o sampling do jogo, não com o default do servidor).
const SAMPLERS = { top_k: 64, min_p: 0.05, repeat_penalty: 1.1 } as unknown as Record<
  never,
  never
>;
const NO_REASONING = { reasoning_effort: "none" } as unknown as { reasoning_effort: "low" };

const client = new OpenAI({ baseURL: BASE_URL, apiKey: "local" });

// ---------------------------------------------------------------------------
// As 4 personas com marcadores verbais únicos e detectáveis
// ---------------------------------------------------------------------------

interface BenchPersona {
  companion: Companion;
  /** Regex do marcador verbal da persona (só conta DENTRO de aspas). */
  marker: RegExp;
  /** Fala-semente do histórico (apresenta a voz uma vez). */
  seedLine: string;
}

function comp(name: string, persona: string): Companion {
  return {
    id: name.toLowerCase(),
    name,
    level: 2,
    ac: 17,
    maxHp: 30,
    currentHp: 30,
    perception: 8,
    conditions: [],
    traits: [],
    persona,
  };
}

const POOL: BenchPersona[] = [
  {
    companion: comp(
      "Sela",
      "Dry-witted veteran bodyguard; clipped sentences; calls the player 'cub' in every line; hates being thanked.",
    ),
    marker: /\bcub\b/i,
    seedLine: `Sela shrugs. "Rain's coming, cub. Sleep with your boots on."`,
  },
  {
    companion: comp(
      "Tobin",
      "Cheerful young scout; starts nearly every line with 'Aye'; endless optimism.",
    ),
    marker: /\baye\b/i,
    seedLine: `Tobin grins across the fire. "Aye, best stew I've had all week!"`,
  },
  {
    companion: comp(
      "Vexria",
      "Bookish tiefling scholar; calls everything 'fascinating'; speaks in precise, long sentences.",
    ),
    marker: /\bfascinating\b/i,
    seedLine: `Vexria closes her journal. "The mineral veins here are, frankly, fascinating."`,
  },
  {
    companion: comp(
      "Doru",
      "Superstitious old porter; swears 'by the Lady' constantly; whispers when nervous.",
    ),
    marker: /\bby the lady\b/i,
    seedLine: `Doru clutches his charm. "By the Lady, don't whistle after dark out here."`,
  },
];

// ---------------------------------------------------------------------------
// Roteiro de turnos (dirige o gate para cada tipo de decisão)
// ---------------------------------------------------------------------------

interface TurnScript {
  playerText: string;
  /** Resumo mecânico sintético (o formato que o narrador recebe no jogo). */
  mechanical: (roster: Companion[]) => string;
}

/** 8 turnos: 3 silêncios, 2 banters, 1 menção, 2 eventos. `turn` = índice+1. */
function script(roster: Companion[]): TurnScript[] {
  const a = roster[0]!;
  const last = roster[roster.length - 1]!;
  const mentionTarget = roster[Math.min(1, roster.length - 1)]!;
  return [
    { playerText: "I keep walking down the forest trail, watching the treeline.", mechanical: () => "" },
    {
      playerText: `I ask ${mentionTarget.name} what they make of these old ruins ahead.`,
      mechanical: () => "",
    },
    { playerText: "I check my pack and keep moving.", mechanical: () => "" }, // turn 3 = banter
    {
      playerText: "I strike the bandit with my longsword!",
      mechanical: () =>
        [
          "1. Ferro Longsword Strike vs Bandit → HIT for 9 slashing; Bandit 25→16 HP.",
          `2. Bandit Strike vs ${a.name} → HIT for 7; ${a.name} 30→23 HP.`,
        ].join("\n"),
    },
    { playerText: "I press forward through the underbrush.", mechanical: () => "" },
    { playerText: "We ford the shallow river and continue north.", mechanical: () => "" }, // turn 6 = banter
    {
      playerText: "I swing at the last bandit!",
      mechanical: () =>
        [
          "1. Ferro Longsword Strike vs Bandit → MISS.",
          `2. Bandit Strike vs ${last.name} → CRITICAL HIT for 14; ${last.name} 23→0 HP — ${last.name} goes DOWN.`,
        ].join("\n"),
    },
    {
      playerText: `I kneel beside ${a.name} — "stay with me!" — and bind the wound.`,
      mechanical: () => `1. Medicine check → SUCCESS: ${a.name} regains 8 HP (0→8).`,
    },
  ];
}

// ---------------------------------------------------------------------------
// Juiz determinístico
// ---------------------------------------------------------------------------

/** Spans entre aspas (retas ou tipográficas) da narração. */
function quotedSpans(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]{2,300})"|“([^”]{2,300})”/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? "");
  return out;
}

/**
 * Atribuição de fala: o nome numa sentença com aspas OU adjacente a uma (o
 * padrão `Tobin's face lights up. "Aye! ..."` atribui pela vizinhança).
 *
 * LIMITE CONHECIDO do juiz (medido em 2026-07-25): a adjacência gera falso
 * positivo quando o narrador põe uma AÇÃO de fundo do companheiro mudo logo
 * depois da fala do escolhido ("Sela remains tense, her eyes fixed…" após uma
 * citação do Tobin). Isso é exatamente o comportamento que a diretiva PEDE —
 * presença sem fala. Ao ler o relatório, confira as violações no transcript
 * antes de tratá-las como regressão: a rodada de 2026-07-25 teve 1 violação
 * reportada em 24 turnos e ela era deste tipo.
 */
function attributedSpeech(narration: string, name: string): boolean {
  const sentences = narration.split(/(?<=[.!?…]["”']?)\s+/);
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const nameRe = new RegExp(`\\b${esc}\\b`, "i");
  const hasQuote = (s: string | undefined) => !!s && /["“”]/.test(s);
  return sentences.some(
    (s, i) =>
      nameRe.test(s) && (hasQuote(s) || hasQuote(sentences[i - 1]) || hasQuote(sentences[i + 1])),
  );
}

interface TurnScore {
  turn: number;
  allowed: string | null;
  reason: string | null;
  /** Companheiros mudos com fala atribuída. */
  wrongSpeakers: string[];
  /** Marcadores de personas mudas dentro de aspas. */
  markerLeaks: string[];
  allowedSpoke: boolean;
  allowedUsedMarker: boolean;
  narration: string;
}

function scoreTurn(
  narration: string,
  roster: BenchPersona[],
  allowed: Companion | null,
  reason: string | null,
  turn: number,
  playerText: string,
): TurnScore {
  const quotes = quotedSpans(narration).join(" || ");
  const wrongSpeakers: string[] = [];
  const markerLeaks: string[] = [];
  for (const p of roster) {
    const isAllowed = allowed?.id === p.companion.id;
    if (isAllowed) continue;
    if (attributedSpeech(narration, p.companion.name)) {
      wrongSpeakers.push(p.companion.name);
    }
    // Marcador em aspas só conta como vazamento se não veio do PRÓPRIO texto
    // do jogador (turno de menção pode ecoar o nome, não o marcador).
    if (p.marker.test(quotes) && !p.marker.test(playerText)) {
      markerLeaks.push(p.companion.name);
    }
  }
  const allowedPersona = roster.find((p) => p.companion.id === allowed?.id);
  return {
    turn,
    allowed: allowed?.name ?? null,
    reason,
    wrongSpeakers,
    markerLeaks,
    allowedSpoke: allowedPersona
      ? attributedSpeech(narration, allowedPersona.companion.name)
      : false,
    allowedUsedMarker: allowedPersona ? allowedPersona.marker.test(quotes) : false,
    narration,
  };
}

// ---------------------------------------------------------------------------
// Execução
// ---------------------------------------------------------------------------

async function narrate(messages: ChatCompletionMessageParam[]): Promise<string> {
  const resp = await client.chat.completions.create({
    model: MODEL,
    messages,
    temperature: 0.6,
    top_p: 0.9,
    max_tokens: 700,
    ...SAMPLERS,
    ...NO_REASONING,
  });
  return resp.choices[0]?.message?.content ?? "";
}

/**
 * `gated` = o jogo real (persona de no máximo 1 por turno, via gate).
 * `all-personas` = CONTROLE: o approach ingênuo que o ADR-004 proíbe — todas
 * as personas no system prompt, nenhuma diretiva de vez — mede o vazamento
 * que o gate existe para impedir.
 */
async function benchSize(n: number, mode: "gated" | "all-personas"): Promise<TurnScore[]> {
  const roster = POOL.slice(0, n);
  const companions = roster.map((p) => p.companion);
  const seed = roster.map((p) => p.seedLine).join(" ");

  const personaBlock =
    mode === "all-personas"
      ? `# Party companions (play them alongside the story)\n${roster
          .map((p) => `- ${p.companion.name}: ${p.companion.persona}`)
          .join("\n")}`
      : "";
  // O controle é o baseline INGÊNUO: sem a regra de gate que a T4 pôs no
  // prompt do narrador (senão o "sem gate" ainda teria meio gate).
  const basePrompt =
    mode === "all-personas"
      ? NARRATIVE_SYSTEM_PROMPT.split("\n")
          .filter((l) => !l.startsWith("- PARTY COMPANIONS speak ONLY"))
          .join("\n")
      : NARRATIVE_SYSTEM_PROMPT;
  const system: ChatCompletionMessageParam = {
    role: "system",
    content: [
      basePrompt,
      `# Setting (player-facing)\nFerro, a human fighter, travels the Vale road with ${
        companions.length
      } companion(s): ${companions.map((c) => c.name).join(", ")}. Bandits prowl these woods.`,
      personaBlock,
    ]
      .filter(Boolean)
      .join("\n\n"),
  };
  // Semente: todas as vozes já falaram uma vez (é daqui que o vazamento nasce).
  const history: ChatCompletionMessageParam[] = [
    { role: "user", content: "We make camp for the night before the long road." },
    {
      role: "assistant",
      content: `The fire crackles as the small company settles in. ${seed} The night passes without incident.`,
    },
  ];

  const scores: TurnScore[] = [];
  for (const [i, t] of script(companions).entries()) {
    const turn = i + 1;
    const mechanical = t.mechanical(companions);
    // No controle o gate ainda DECIDE (é a régua da pontuação: quem PODERIA
    // falar), mas a diretiva não é injetada — o narrador fica solto.
    const pick = pickVoice(companions, { playerText: t.playerText, mechanical, turn });
    const voiceLine = mode === "gated" ? voiceDirective(pick, companions) : "";
    const stateLine = `[PLAYER STATE: Ferro is ALIVE, conscious and able to act.]`;
    const results: ChatCompletionMessageParam = {
      role: "user",
      content: mechanical
        ? `[GM ENGINE — WHAT ACTUALLY HAPPENED THIS TURN. Narrate every numbered line faithfully.]\n${mechanical}\n${stateLine}\n${voiceLine}`
        : `[GM ENGINE] No roll was needed and NO mechanical effect happened.\n${stateLine}\n${voiceLine}`,
    };
    history.push({ role: "user", content: t.playerText });
    const narration = await narrate([system, ...history, results]);
    history.push({ role: "assistant", content: narration });
    scores.push(
      scoreTurn(narration, roster, pick?.companion ?? null, pick?.reason ?? null, turn, t.playerText),
    );
    process.stdout.write(".");
  }
  return scores;
}

function summarize(n: number, scores: TurnScore[]): string {
  const silenceTurns = scores.filter((s) => !s.allowed);
  const speakTurns = scores.filter((s) => s.allowed);
  const silenceViol = silenceTurns.filter((s) => s.wrongSpeakers.length > 0).length;
  const wrongViol = speakTurns.filter((s) => s.wrongSpeakers.length > 0).length;
  const leaks = scores.reduce((a, s) => a + s.markerLeaks.length, 0);
  const spoke = speakTurns.filter((s) => s.allowedSpoke).length;
  const marker = speakTurns.filter((s) => s.allowedUsedMarker).length;
  return [
    `| ${n} | ${scores.length} | ${silenceViol}/${silenceTurns.length} | ${wrongViol}/${speakTurns.length} | ${leaks} | ${spoke}/${speakTurns.length} | ${marker}/${speakTurns.length} |`,
  ].join("\n");
}

async function main() {
  const health = await fetch(`${BASE_URL.replace(/\/v1\/?$/, "")}/health`).catch(() => null);
  if (!health?.ok) {
    console.error(`llama-server não responde em ${BASE_URL} — rode gemma-up antes.`);
    process.exit(1);
  }
  mkdirSync(join(here, "transcripts"), { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const rows: string[] = [];
  const controlRows: string[] = [];
  for (const n of SIZES) {
    process.stdout.write(`party de ${n} persona(s) [gated] `);
    let started = Date.now();
    const scores = await benchSize(n, "gated");
    rows.push(summarize(n, scores));
    console.log(` ${Math.round((Date.now() - started) / 1000)}s`);
    writeFileSync(
      join(here, "transcripts", `voices-${n}-${date}.json`),
      JSON.stringify(scores, null, 1),
    );
    process.stdout.write(`party de ${n} persona(s) [controle] `);
    started = Date.now();
    const control = await benchSize(n, "all-personas");
    controlRows.push(summarize(n, control));
    console.log(` ${Math.round((Date.now() - started) / 1000)}s`);
    writeFileSync(
      join(here, "transcripts", `voices-${n}-control-${date}.json`),
      JSON.stringify(control, null, 1),
    );
  }
  const header =
    "| Personas | Turnos | Viol. silêncio | Viol. fala errada | Marker leaks | Escolhido falou | Usou marcador |";
  const report = [
    `# Voice bench — ${date} (BANTER_EVERY=${BANTER_EVERY}, modelo: ${MODEL})`,
    "",
    "Turnos por tamanho: 8 (3 silêncio, 2 banter, 1 menção, 2 evento).",
    "Violações: fala atribuída a companheiro que o GATE não escolheu. Leaks:",
    "marcador verbal de persona não-escolhida dentro de aspas. Falou/Marcador:",
    "aderência do ESCOLHIDO.",
    "",
    "## Com o gate (o jogo real)",
    "",
    header,
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
    "## CONTROLE — sem gate, todas as personas no prompt (o que o ADR-004 proíbe)",
    "",
    "A régua de pontuação é a mesma (o gate decide quem PODERIA falar); a",
    "diretiva é omitida e todas as personas entram juntas no system prompt.",
    "",
    header,
    "|---|---|---|---|---|---|---|",
    ...controlRows,
    "",
    "Transcripts por tamanho em `transcripts/voices-N[-control]-*.json`.",
  ].join("\n");
  const path = join(here, `report-${date}.md`);
  writeFileSync(path, report);
  console.log(`\nRelatório: ${path}`);
}

main().catch((err) => {
  console.error("FALHA:", err);
  process.exit(1);
});
