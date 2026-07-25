/**
 * Cenários de ALIADO em campo (T5 da Fase 2, ADR-004) — extensão da feat-audit.
 *
 * End-to-end contra o servidor real (porta 3101, BRAIN_PATH em sandbox — a
 * bateria NUNCA toca o brain do jogador): recrutamento vira tool call,
 * companheiro entra no combate como ally, o turno dele roda na engine, e o
 * modelo NÃO recruta transeunte nem dubla companheiro fora do gate.
 *
 * Uso:  npx tsx scripts/feat-audit/run-ally-scenarios.ts [--port=3101]
 * Saída: ally-report-<data>.md + transcripts/ally-*.json neste diretório.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(here, "../..");
const EXAMPLE_CHAR = join(SERVER_DIR, "../../exemplo_personagem.json");
const TRANSCRIPTS = join(here, "transcripts");
const BRAIN_SANDBOX = join(here, ".brain-sandbox");
const PORT = Number(process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 3101);
const BASE = `http://localhost:${PORT}`;

// --------------------------------------------------------------------------
// Servidor temporário (mesmo padrão do run-feat-tests: grupo próprio + sandbox)
// --------------------------------------------------------------------------

let serverProc: ChildProcess | null = null;
let serverLog = "";

async function startServer(): Promise<void> {
  const tsxBin = join(SERVER_DIR, "../../node_modules/.bin/tsx");
  rmSync(BRAIN_SANDBOX, { recursive: true, force: true });
  mkdirSync(BRAIN_SANDBOX, { recursive: true });
  serverProc = spawn(tsxBin, ["src/http/server.ts"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(PORT), BRAIN_PATH: join(BRAIN_SANDBOX, "brain") },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  serverProc.stdout?.on("data", (d: Buffer) => (serverLog += d.toString()));
  serverProc.stderr?.on("data", (d: Buffer) => (serverLog += d.toString()));
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      /* subindo */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Servidor não subiu em ${BASE}`);
}

function stopServer(): void {
  if (serverProc?.pid) {
    try {
      process.kill(-serverProc.pid, "SIGTERM");
    } catch {
      serverProc.kill("SIGTERM");
    }
  }
  serverProc = null;
  rmSync(BRAIN_SANDBOX, { recursive: true, force: true });
}

// --------------------------------------------------------------------------
// Turno via SSE (idêntico ao harness principal)
// --------------------------------------------------------------------------

interface CheckEv {
  label: string;
  degree: string;
  attack?: { attacker: string; target: string; attackerKind: string; outcome: string } | null;
}
interface TurnResult {
  input: string;
  narrative: string;
  checks: CheckEv[];
  finalState: Record<string, unknown> | null;
  toolLines: string[];
  seconds: number;
}

async function runTurn(sessionId: string, text: string): Promise<TurnResult> {
  const logStart = serverLog.length;
  const started = Date.now();
  const res = await fetch(`${BASE}/scene/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, text }),
  });
  if (!res.ok || !res.body) throw new Error(`turn HTTP ${res.status}: ${await res.text()}`);
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
  const toolLines = serverLog
    .slice(logStart)
    .split("\n")
    .filter((l) => l.includes("tool ") && l.includes("[GM][rules]"));
  return {
    input: text,
    narrative,
    checks,
    finalState,
    toolLines,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

// --------------------------------------------------------------------------
// Cenários e juiz
// --------------------------------------------------------------------------

interface Verdict {
  scenario: string;
  verdict: "PASS" | "FAIL" | "SUSPECT";
  notes: string[];
  seconds: number;
}

type StateShape = {
  companions?: { name: string }[];
  combat?: { active?: boolean; combatants?: { name: string; kind: string }[] } | null;
} | null;

interface AllyScenario {
  name: string;
  turns: string[];
  judge: (turns: TurnResult[]) => Verdict;
}

function usedTool(t: TurnResult, tool: string): boolean {
  return t.toolLines.some((l) => l.includes(`tool ${tool}(`) && !l.includes("-> ERROR"));
}

const SCENARIOS: AllyScenario[] = [
  {
    // O caminho feliz inteiro: recrutar → combate com ally → turno do ally.
    name: "recruit-and-fight",
    turns: [
      "On the road I meet Sela, a veteran huntress. I hire her to travel with me as my companion, and she accepts.",
      "A lone bandit blocks the road, draws his blade and attacks us!",
      "I strike the bandit with my longsword!",
    ],
    judge: (turns) => {
      const notes: string[] = [];
      let verdict: Verdict["verdict"] = "PASS";
      const afterRecruit = turns[0]!.finalState as StateShape;
      if (!usedTool(turns[0]!, "manage_companion")) {
        verdict = "FAIL";
        notes.push("recrutamento declarado sem manage_companion");
      } else if (!afterRecruit?.companions?.some((c) => /sela/i.test(c.name))) {
        verdict = "FAIL";
        notes.push("manage_companion rodou mas Sela não está no roster");
      }
      const combatState = (turns[2]!.finalState ?? turns[1]!.finalState) as StateShape;
      const allyInCombat = combatState?.combat?.combatants?.some(
        (c) => c.kind === "ally" && /sela/i.test(c.name),
      );
      const combatHappened = [turns[1]!, turns[2]!].some((t) => usedTool(t, "start_combat"));
      if (!combatHappened) {
        if (verdict === "PASS") verdict = "SUSPECT";
        notes.push("combate nunca começou — cenário não exercitou o ally");
      } else if (!allyInCombat && combatState?.combat) {
        verdict = "FAIL";
        notes.push("combate ativo sem a companheira como ally");
      }
      const allyStruck = [turns[1]!, turns[2]!].some((t) =>
        t.checks.some((c) => c.attack?.attackerKind === "ally"),
      );
      if (combatHappened && !allyStruck) {
        verdict = "FAIL";
        notes.push("turno do ally não rodou (nenhum Strike com attackerKind=ally)");
      }
      return { scenario: "recruit-and-fight", verdict, notes, seconds: sum(turns) };
    },
  },
  {
    // Transeunte NÃO vira companheiro (modo de falha do prompt).
    name: "no-bystander-recruit",
    turns: [
      "I arrive at a busy roadside tavern and chat with the barkeep about local rumors.",
    ],
    judge: (turns) => {
      const notes: string[] = [];
      let verdict: Verdict["verdict"] = "PASS";
      if (usedTool(turns[0]!, "manage_companion")) {
        verdict = "FAIL";
        notes.push("modelo recrutou um transeunte (barkeep) como companheiro");
      }
      return { scenario: "no-bystander-recruit", verdict, notes, seconds: sum(turns) };
    },
  },
  {
    // Despedida definitiva vira leave (e o roster esvazia).
    name: "farewell",
    turns: [
      "I meet Tobin, a young scout, and take him on as my traveling companion.",
      "At the crossroads Tobin and I part ways for good — he heads home to his village. I wish him well and continue alone.",
    ],
    judge: (turns) => {
      const notes: string[] = [];
      let verdict: Verdict["verdict"] = "PASS";
      if (!usedTool(turns[0]!, "manage_companion")) {
        verdict = "SUSPECT";
        notes.push("recrutamento do Tobin não usou manage_companion — leave não testável");
        return { scenario: "farewell", verdict, notes, seconds: sum(turns) };
      }
      const after = turns[1]!.finalState as StateShape;
      const leaveCalled = usedTool(turns[1]!, "manage_companion");
      const stillThere = after?.companions?.some((c) => /tobin/i.test(c.name));
      if (!leaveCalled) {
        verdict = "FAIL";
        notes.push("despedida definitiva sem manage_companion leave");
      } else if (stillThere) {
        verdict = "FAIL";
        notes.push("leave rodou mas Tobin segue no roster");
      }
      return { scenario: "farewell", verdict, notes, seconds: sum(turns) };
    },
  },
];

function sum(turns: TurnResult[]): number {
  return turns.reduce((a, t) => a + t.seconds, 0);
}

// --------------------------------------------------------------------------
// Main
// --------------------------------------------------------------------------

async function main() {
  mkdirSync(TRANSCRIPTS, { recursive: true });
  await startServer();
  console.log(`Servidor de teste em ${BASE}.`);
  const results: Verdict[] = [];
  try {
    for (const s of SCENARIOS) {
      process.stdout.write(`${s.name} ... `);
      try {
        const imp = await fetch(`${BASE}/character/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(JSON.parse(readFileSync(EXAMPLE_CHAR, "utf8"))),
        });
        if (!imp.ok) throw new Error(`import ${imp.status}`);
        const { sessionId } = (await imp.json()) as { sessionId: string };
        const turns: TurnResult[] = [];
        for (const input of s.turns) turns.push(await runTurn(sessionId, input));
        const verdict = s.judge(turns);
        results.push(verdict);
        writeFileSync(
          join(TRANSCRIPTS, `ally-${s.name}.json`),
          JSON.stringify({ scenario: s.name, turns, verdict }, null, 1),
        );
        console.log(`${verdict.verdict} (${verdict.seconds}s)${verdict.notes.length ? ` — ${verdict.notes[0]}` : ""}`);
      } catch (err) {
        results.push({
          scenario: s.name,
          verdict: "SUSPECT",
          notes: [`erro do harness: ${(err as Error).message.slice(0, 120)}`],
          seconds: 0,
        });
        console.log(`ERRO — ${(err as Error).message.slice(0, 80)}`);
      }
    }
  } finally {
    stopServer();
  }
  const date = new Date().toISOString().slice(0, 10);
  const count = (v: string) => results.filter((r) => r.verdict === v).length;
  const report = [
    `# Ally scenarios — ${date}`,
    "",
    `${results.length} cenários | PASS ${count("PASS")} · FAIL ${count("FAIL")} · SUSPECT ${count("SUSPECT")}`,
    "",
    "| Cenário | Veredito | Notas |",
    "|---|---|---|",
    ...results.map((r) => `| ${r.scenario} | ${r.verdict} | ${r.notes.join("; ") || "—"} |`),
  ].join("\n");
  const path = join(here, `ally-report-${date}.md`);
  writeFileSync(path, report);
  console.log(`Relatório: ${path}`);
  process.exit(0);
}

main().catch((err) => {
  stopServer();
  console.error("FALHA:", err);
  process.exit(1);
});
