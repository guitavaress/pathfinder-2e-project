/**
 * Bateria de teste de FEATS contra o GM (modelo + engine), por arquétipo.
 *
 * Para cada feat da battery.json: importa um personagem-template com o feat
 * INJETADO na ficha, roda o cenário (combate: 2 turnos; fora: 1 turno) contra
 * um servidor temporário (:3101, processo-filho — stdout capturado para ler as
 * tool calls) e aplica asserções automáticas. Vereditos: PASS / FAIL (violação
 * dura) / SUSPECT (fora do happy-path; revisão humana em lote).
 *
 * Uso:
 *   npx tsx scripts/feat-audit/run-feat-tests.ts [--side=combat|noncombat]
 *     [--archetype=nome] [--feat="Nome"] [--limit=N] [--port=3101] [--fresh]
 *     [--repeat=N]
 *
 * `--repeat=N` roda cada cenário N vezes e reporta a TAXA de PASS (o estágio de
 * regras roda a temperature 0.3 e alterna entre rodadas). Cenário que passa
 * numa e falha noutra vira FLAKY — informação que o veredito binário destrói.
 *
 * Retomada: progress.json guarda os resultados; re-rodar pula os já feitos
 * (use --fresh para zerar). Relatório: report-<data>.md. Transcripts completos
 * por cenário em transcripts/ (para a revisão humana dos SUSPECT).
 */
import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  aggregate,
  judge,
  type BatteryFeat,
  type CheckEv,
  type Scenario,
  type ScenarioResult,
  type TurnResult,
  type Verdict,
} from "./judge.js";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(here, "../..");
const EXAMPLE_CHAR = join(SERVER_DIR, "../../exemplo_personagem.json");
const BATTERY = join(here, "battery.json");
const PROGRESS = join(here, "progress.json");
const TRANSCRIPTS = join(here, "transcripts");
/**
 * Brain DESCARTÁVEL da bateria. Sem isto o servidor-filho herda o `BRAIN_PATH`
 * default e a bateria roda contra o `brain/` REAL do jogador: cada cenário
 * importa um personagem, e importar arquiva a campanha em andamento. Em
 * 2026-07-24 uma rodada deslocou a campanha viva para `brain-archive-*` no
 * primeiro cenário. Isolar aqui é o que mantém a bateria sem efeito colateral.
 */
const BRAIN_SANDBOX = join(here, ".brain-sandbox");

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function argValue(name: string): string | null {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : null;
}
const ONLY_SIDE = argValue("side"); // combat | noncombat
const ONLY_ARCHETYPE = argValue("archetype");
const ONLY_FEATS = argValue("feat")
  ?.split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const LIMIT = Number(argValue("limit") ?? Infinity);
const PORT = Number(argValue("port") ?? 3101);
const FRESH = argv.includes("--fresh");
/**
 * Quantas vezes rodar CADA cenário. O estágio de regras roda a temperature
 * 0.3: o mesmo cenário alterna entre rodadas, e um veredito binário fazia essa
 * variância parecer regressão (ou melhora) entre gates. Com N>1 o resultado
 * vira taxa e cenários instáveis ganham o veredito próprio FLAKY.
 * Custo: multiplica o tempo da bateria por N.
 */
const REPEAT = Math.max(1, Number(argValue("repeat") ?? 1));
const BASE = `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Cenários a partir da battery.json
// ---------------------------------------------------------------------------

function loadScenarios(): Scenario[] {
  const b = JSON.parse(readFileSync(BATTERY, "utf8")) as {
    combat: Record<string, BatteryFeat[]>;
    noncombat: Record<string, BatteryFeat[]>;
  };
  const out: Scenario[] = [];
  for (const [arch, feats] of Object.entries(b.combat)) {
    for (const f of feats) out.push({ ...f, side: "combat", archetype: arch });
  }
  for (const [arch, feats] of Object.entries(b.noncombat)) {
    for (const f of feats) out.push({ ...f, side: "noncombat", archetype: arch });
  }
  return out.filter(
    (s) =>
      (!ONLY_SIDE || s.side === ONLY_SIDE) &&
      (!ONLY_ARCHETYPE || s.archetype === ONLY_ARCHETYPE) &&
      (!ONLY_FEATS || ONLY_FEATS.includes(s.name)),
  );
}

/** Frase de uso por arquétipo (o modelo consulta a regra via lookup_rule). */
function useLine(s: Scenario): string {
  switch (s.archetype) {
    case "atividade-multi-strike":
    case "strike-modificada":
      return `I use ${s.name} against the bandit!`;
    case "condicao-via-check":
      return `I use ${s.name} on the bandit.`;
    case "stance":
      return `I enter ${s.name}, then strike the bandit once.`;
    case "movimento-tatico":
      return `I use ${s.name} to close the distance and strike the bandit.`;
    case "reacao-defensiva":
    case "reacao-ofensiva":
      return `I stay on guard: the next time the bandit attacks me, I use ${s.name}. Meanwhile I strike him once.`;
    case "buff-suporte":
      return `Mid-fight, I use ${s.name}.`;
    case "passivo-combate":
    case "combate-outro":
      // Feat com custo de ação = uso ATIVO (senão o cenário nunca o exercita:
      // Bon Mot virou uma Strike comum no dry-run). Passivo = Strike + lembrete.
      return s.actionType === "action"
        ? `I use ${s.name} on the bandit!`
        : `I strike the bandit with my weapon. (Remember my feat ${s.name}.)`;
    case "skill-activity":
      return `Here at the tavern, I use ${s.name}.`;
    case "downtime":
      return `I settle in town for a few days and use ${s.name}.`;
    case "social-influencia":
      return `Talking with the barkeep, I use ${s.name}.`;
    case "exploracao":
      return `As I travel the wilderness trail, I use ${s.name}.`;
    default:
      return `While at the tavern, I make use of my ${s.name} ability, describing how it helps me now.`;
  }
}

function turnsFor(s: Scenario): string[] {
  if (s.side === "combat") {
    return [
      "A lone bandit blocks the road, draws his blade and attacks me!",
      useLine(s),
    ];
  }
  return [`I arrive at a busy roadside tavern. ${useLine(s)}`];
}

// ---------------------------------------------------------------------------
// Personagens-template (feat injetado)
// ---------------------------------------------------------------------------

function makeCharacter(s: Scenario): unknown {
  const doc = JSON.parse(readFileSync(EXAMPLE_CHAR, "utf8")) as {
    build: Record<string, unknown>;
  };
  const b = doc.build;
  const wantsRogue = s.traits.some((t) => ["rogue", "goblin"].includes(t));
  if (!wantsRogue) {
    // Template marcial genérico: Fighter humano 5, espada longa + escudo.
    b.name = "Ferro";
    b.class = "Fighter";
    b.ancestry = "Human";
    b.heritage = "Versatile Heritage";
    b.background = "Guard";
    b.keyability = "str";
    b.abilities = {
      str: 18,
      dex: 14,
      con: 16,
      int: 10,
      wis: 12,
      cha: 10,
    };
    b.weapons = [
      {
        name: "Longsword",
        qty: 1,
        prof: "martial",
        die: "d8",
        pot: 0,
        str: "",
        mat: null,
        display: "Longsword",
        runes: [],
        damageType: "S",
        attack: 13,
        damageBonus: 4,
        extraDamage: [],
        increasedDice: false,
        isInventor: false,
        grade: "",
      },
      // 2ª arma + escudo: a engine agora VALIDA Requirements pela ficha
      // (Double Slice exige duas armas; Reactive Shield/Raise a Shield exigem
      // escudo) — o template precisa suportar os feats que testa.
      {
        name: "Shortsword",
        qty: 1,
        prof: "martial",
        die: "d6",
        pot: 0,
        str: "",
        mat: null,
        display: "Shortsword",
        runes: [],
        damageType: "P",
        attack: 13,
        damageBonus: 4,
        extraDamage: [],
        increasedDice: false,
        isInventor: false,
        grade: "",
      },
    ];
    const equipment = (b.equipment ?? []) as unknown[][];
    equipment.push(["Steel Shield", 1]);
    b.equipment = equipment;
    b.specials = [];
  }
  // Isola o feat sob teste (ficha só com ele + formato Pathbuilder).
  b.feats = [[s.name, null, "Class Feat", 1]];
  return doc;
}

// ---------------------------------------------------------------------------
// Servidor temporário (stdout = fonte das tool calls)
// ---------------------------------------------------------------------------

let serverProc: ChildProcess | null = null;
let serverLog = "";

async function startServer(): Promise<void> {
  // tsx direto (não npx) + grupo de processos próprio: `npx` gera netos que
  // sobrevivem ao SIGTERM do pai e seguram o pipe de stdout — o harness então
  // nunca sai (ficou 2h preso no dry-run). Matamos o GRUPO no stop.
  const tsxBin = join(SERVER_DIR, "../../node_modules/.bin/tsx");
  // BRAIN_PATH no sandbox: a bateria nunca toca o brain real (ver BRAIN_SANDBOX).
  rmSync(BRAIN_SANDBOX, { recursive: true, force: true });
  mkdirSync(BRAIN_SANDBOX, { recursive: true });
  serverProc = spawn(tsxBin, ["src/http/server.ts"], {
    cwd: SERVER_DIR,
    env: {
      ...process.env,
      PORT: String(PORT),
      BRAIN_PATH: join(BRAIN_SANDBOX, "brain"),
    },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  serverProc.stdout?.on("data", (d: Buffer) => (serverLog += d.toString()));
  serverProc.stderr?.on("data", (d: Buffer) => (serverLog += d.toString()));
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return;
    } catch {
      /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Servidor não subiu em ${BASE}`);
}

function stopServer(): void {
  if (serverProc?.pid) {
    try {
      process.kill(-serverProc.pid, "SIGTERM"); // grupo inteiro (tsx + node filho)
    } catch {
      serverProc.kill("SIGTERM");
    }
  }
  serverProc = null;
  // O sandbox acumula um `brain-archive-*` por cenário; não serve para nada
  // depois da rodada e o próximo start recria do zero.
  rmSync(BRAIN_SANDBOX, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Execução de turno via SSE
// ---------------------------------------------------------------------------

async function runTurn(sessionId: string, text: string): Promise<TurnResult> {
  const logStart = serverLog.length;
  const started = Date.now();
  const res = await fetch(`${BASE}/scene/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, text }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`turn HTTP ${res.status}: ${await res.text()}`);
  }
  let narrative = "";
  const checks: CheckEv[] = [];
  let finalState: Record<string, unknown> | null = null;
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let sep;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        try {
          const ev = JSON.parse(line.slice(6));
          if (ev.type === "delta") narrative += ev.text;
          else if (ev.type === "check") checks.push(ev.result);
          else if (ev.type === "state") finalState = ev.state;
        } catch {
          /* frame parcial */
        }
      }
    }
  }
  const slice = serverLog.slice(logStart);
  const lines = slice.split("\n");
  const toolLines = lines.filter(
    (l) => l.includes("tool ") && l.includes("[GM][rules]"),
  );
  const errorLines = toolLines.filter((l) => l.includes("-> ERROR"));
  // O resumo mecânico é o que a engine DECLARA ao narrador. O juiz precisa dele
  // para distinguir "a engine avisou que nada se aplicava" (doutrina 4
  // funcionando) de "o modelo fugiu da mecânica" — ver `engineDeclaredVoid`.
  const mechanicalSummary = lines
    .filter((l) => l.includes("[GM] mechanical summary:"))
    .map((l) => l.split("[GM] mechanical summary:")[1]?.trim() ?? "")
    .pop();
  return {
    input: text,
    narrative,
    checks,
    finalState,
    toolLines,
    errorLines,
    seconds: Math.round((Date.now() - started) / 1000),
    mechanicalSummary,
  };
}

// ---------------------------------------------------------------------------
// Progresso + relatório
// ---------------------------------------------------------------------------

type Progress = Record<string, ScenarioResult>;

function loadProgress(): Progress {
  if (FRESH || !existsSync(PROGRESS)) return {};
  try {
    return JSON.parse(readFileSync(PROGRESS, "utf8")) as Progress;
  } catch {
    return {};
  }
}

function writeReport(progress: Progress): string {
  const date = new Date().toISOString().slice(0, 10);
  const path = join(here, `report-${date}.md`);
  const all = Object.values(progress);
  const count = (v: string) => all.filter((r) => r.verdict === v).length;
  const usage = (k: string) => all.filter((r) => r.usage?.kind === k).length;
  const asserted = usage("confirmed") + usage("missing");
  const repeats = Math.max(1, ...all.map((r) => r.passRate?.total ?? 1));
  const lines = [
    `# Feat audit — ${date}`,
    "",
    `${all.length} cenários | PASS ${count("PASS")} · FAIL ${count("FAIL")} · SUSPECT ${count("SUSPECT")}` +
      (count("FLAKY") ? ` · FLAKY ${count("FLAKY")}` : ""),
    "",
    ...(repeats > 1
      ? [
          `Cada cenário rodou **${repeats}×** (\`--repeat\`). FLAKY = passou numa rodada e ` +
            `falhou noutra — instabilidade do modelo, não defeito determinístico.`,
          "",
        ]
      : []),
    // A cobertura é tão importante quanto o veredito: um PASS sem asserção de
    // uso não prova que o feat funcionou, só que nada explodiu.
    `**Cobertura de asserção de uso: ${asserted}/${all.length}** ` +
      `(uso confirmado ${usage("confirmed")} · uso ausente ${usage("missing")} · ` +
      `sem asserção ${usage("not-asserted")}). Cenários "sem asserção" são ponto ` +
      `cego declarado — passar ali significa apenas que nada quebrou.`,
    "",
  ];
  const noAssert = all.filter((r) => r.usage?.kind === "not-asserted");
  if (noAssert.length) {
    lines.push(
      "<details><summary>Cenários sem asserção de uso</summary>",
      "",
      ...noAssert.map((r) => `- \`${r.feat}\` — ${r.usage.kind === "not-asserted" ? r.usage.why : ""}`),
      "",
      "</details>",
      "",
    );
  }
  const byArch = new Map<string, ScenarioResult[]>();
  for (const r of all) {
    const key = `${r.side} / ${r.archetype}`;
    byArch.set(key, [...(byArch.get(key) ?? []), r]);
  }
  for (const [arch, list] of byArch) {
    const rateCol = repeats > 1 ? " Taxa |" : "";
    const rateSep = repeats > 1 ? "---|" : "";
    lines.push(
      `## ${arch}`,
      "",
      `| Feat | Veredito |${rateCol} Uso | Ações | Tools | Notas |`,
      `|---|---|${rateSep}---|---|---|---|`,
    );
    for (const r of list) {
      const u =
        r.usage?.kind === "confirmed" ? "✅" : r.usage?.kind === "missing" ? "❌" : "—";
      const rate =
        repeats > 1 ? ` ${r.passRate?.passed ?? "—"}/${r.passRate?.total ?? "—"} |` : "";
      lines.push(
        `| ${r.feat} | ${r.verdict} |${rate} ${u} | ${r.actionsSpent ?? "—"} | ${r.toolsUsed.join(", ") || "—"} | ${r.notes.join("; ") || "—"} |`,
      );
    }
    lines.push("");
  }
  writeFileSync(path, lines.join("\n"));
  return path;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const scenarios = loadScenarios();
  const progress = loadProgress();
  const pending = scenarios.filter((s) => !progress[s.name]).slice(0, LIMIT);
  console.log(
    `Bateria: ${scenarios.length} cenários no filtro; ${pending.length} a rodar (${Object.keys(progress).length} já no progresso).`,
  );
  if (pending.length === 0) {
    console.log(`Relatório: ${writeReport(progress)}`);
    return;
  }

  mkdirSync(TRANSCRIPTS, { recursive: true });
  await startServer();
  console.log(`Servidor de teste em ${BASE}.`);

  try {
    for (const [i, s] of pending.entries()) {
      const started = Date.now();
      process.stdout.write(
        `[${i + 1}/${pending.length}] ${s.side}/${s.archetype} — ${s.name} ... `,
      );
      try {
        // Cada rodada é uma SESSÃO NOVA (import próprio): sem isso a segunda
        // repetição herdaria o combate e o histórico da primeira, e mediria
        // outra coisa. O último conjunto de turnos vira o transcript.
        const runs: Verdict[] = [];
        let lastTurns: TurnResult[] = [];
        for (let attempt = 0; attempt < REPEAT; attempt++) {
          const imp = await fetch(`${BASE}/character/import`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(makeCharacter(s)),
          });
          if (!imp.ok) throw new Error(`import ${imp.status}: ${await imp.text()}`);
          const { sessionId } = (await imp.json()) as { sessionId: string };
          const turns: TurnResult[] = [];
          for (const input of turnsFor(s)) {
            turns.push(await runTurn(sessionId, input));
          }
          runs.push(judge(s, turns));
          lastTurns = turns;
        }
        const result = aggregate(runs);
        progress[s.name] = result;
        const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        writeFileSync(
          join(TRANSCRIPTS, `${slug}.json`),
          JSON.stringify({ scenario: s, turns: lastTurns, verdict: result }, null, 1),
        );
        const rate =
          REPEAT > 1 ? ` [${result.passRate.passed}/${result.passRate.total} PASS]` : "";
        console.log(
          `${result.verdict}${rate} (${Math.round((Date.now() - started) / 1000)}s)${
            result.notes.length ? ` — ${result.notes[0]}` : ""
          }`,
        );
      } catch (err) {
        progress[s.name] = {
          feat: s.name,
          side: s.side,
          archetype: s.archetype,
          verdict: "SUSPECT",
          actionsSpent: null,
          toolsUsed: [],
          notes: [`erro do harness: ${(err as Error).message.slice(0, 120)}`],
          seconds: Math.round((Date.now() - started) / 1000),
          usage: { kind: "not-asserted", why: "o cenário nem chegou a rodar" },
          runs: [],
          passRate: { passed: 0, total: 0 },
        };
        console.log(`ERRO — ${(err as Error).message.slice(0, 80)}`);
      }
      writeFileSync(PROGRESS, JSON.stringify(progress, null, 1));
    }
  } finally {
    stopServer();
  }
  console.log(`Relatório: ${writeReport(progress)}`);
  // Saída explícita: mesmo que reste algum handle aberto (pipe do servidor
  // morto), o harness não pode ficar pendurado.
  process.exit(0);
}

main().catch((err) => {
  stopServer();
  console.error("FALHA:", err);
  process.exit(1);
});
