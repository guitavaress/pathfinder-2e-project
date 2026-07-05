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
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(here, "../..");
const EXAMPLE_CHAR = join(SERVER_DIR, "../../exemplo_personagem.json");
const BATTERY = join(here, "battery.json");
const PROGRESS = join(here, "progress.json");
const TRANSCRIPTS = join(here, "transcripts");

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
const BASE = `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Cenários a partir da battery.json
// ---------------------------------------------------------------------------

interface BatteryFeat {
  name: string;
  level: number | null;
  actionType: string | null;
  actionCost: number | null;
  traits: string[];
}
interface Scenario extends BatteryFeat {
  side: "combat" | "noncombat";
  archetype: string;
}

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
    ];
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
  serverProc = spawn(tsxBin, ["src/http/server.ts"], {
    cwd: SERVER_DIR,
    env: { ...process.env, PORT: String(PORT) },
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
}

// ---------------------------------------------------------------------------
// Execução de turno via SSE
// ---------------------------------------------------------------------------

interface CheckEv {
  label: string;
  die: number;
  total: number;
  dc: number;
  degree: string;
  attack?: {
    attacker: string;
    target: string;
    attackerKind: string;
    outcome: string;
    damage: number | null;
    damageType: string | null;
  } | null;
}
interface TurnResult {
  input: string;
  narrative: string;
  checks: CheckEv[];
  finalState: Record<string, unknown> | null;
  toolLines: string[];
  errorLines: string[];
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
  const toolLines = slice
    .split("\n")
    .filter((l) => l.includes("tool ") && l.includes("[GM][rules]"));
  const errorLines = toolLines.filter((l) => l.includes("-> ERROR"));
  return {
    input: text,
    narrative,
    checks,
    finalState,
    toolLines,
    errorLines,
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

// ---------------------------------------------------------------------------
// Asserções
// ---------------------------------------------------------------------------

interface Verdict {
  feat: string;
  side: string;
  archetype: string;
  verdict: "PASS" | "FAIL" | "SUSPECT";
  actionsSpent: number | null;
  toolsUsed: string[];
  notes: string[];
  seconds: number;
}

function playerFromState(state: Record<string, unknown> | null): Record<string, unknown> | null {
  const combat = (state as { combat?: { active?: boolean; combatants?: Record<string, unknown>[] } } | null)?.combat;
  if (!combat?.combatants) return null;
  return combat.combatants.find((c) => c.kind === "player") ?? null;
}

const FALSE_BLOW_KW =
  /\b(blade|dagger|sword|strike|blow|fist|steel)\b[^.!]{0,60}\b(sinks|buries|slams into|connects|lands (solidly|squarely|true)|bites into|tears through|pierces)\b/i;

function judge(s: Scenario, turns: TurnResult[]): Verdict {
  const notes: string[] = [];
  let verdict: Verdict["verdict"] = "PASS";
  const useTurn = turns[turns.length - 1]!;
  const toolsUsed = [
    ...new Set(
      useTurn.toolLines
        .map((l) => l.match(/tool (\w+)\(/)?.[1] ?? "")
        .filter(Boolean),
    ),
  ];

  // Economia de ação (só no turno de uso, em combate, para feats com custo).
  let actionsSpent: number | null = null;
  const player = playerFromState(useTurn.finalState);
  const combatActive = (useTurn.finalState as { combat?: { active?: boolean } } | null)?.combat?.active;
  if (s.side === "combat" && player && typeof player.actionsRemaining === "number") {
    actionsSpent = 3 - (player.actionsRemaining as number);
    if (
      s.actionType === "action" &&
      (s.actionCost ?? 0) >= 1 &&
      combatActive &&
      actionsSpent < (s.actionCost ?? 0)
    ) {
      verdict = "FAIL";
      notes.push(
        `custo de ação não cobrado: feat custa ${s.actionCost}, turno gastou ${actionsSpent}`,
      );
    }
  }

  // DC inválido passou pela engine? (não deveria ser possível)
  for (const c of useTurn.checks) {
    if (!c.attack && c.dc < 5) {
      verdict = "FAIL";
      notes.push(`check com DC inválido (${c.dc}) escapou do guard`);
    }
  }

  // Golpe narrado sem mecânica correspondente.
  const anyHit = useTurn.checks.some(
    (c) => c.attack && (c.attack.outcome === "hit" || c.attack.outcome === "criticalHit"),
  );
  if (s.side === "combat" && !anyHit && FALSE_BLOW_KW.test(useTurn.narrative)) {
    verdict = "FAIL";
    notes.push("narrativa descreve golpe conectando, mas nenhum hit mecânico ocorreu");
  }

  // Dupla contagem: update_state com hpDelta negativo no mesmo turno de um
  // hit — só conta se a engine ACEITOU (chamadas rejeitadas pelo guard são o
  // comportamento correto, não uma falha).
  const manualDamage = useTurn.toolLines.some(
    (l) =>
      l.includes("update_state") &&
      /"hpDelta":-\d+/.test(l) &&
      /"target"/.test(l) &&
      !l.includes("-> ERROR"),
  );
  if (anyHit && manualDamage) {
    verdict = "FAIL";
    notes.push("dupla contagem: hit da engine + hpDelta manual no mesmo turno");
  }

  // Erros de tool não recuperados (nenhuma tool bem-sucedida depois).
  if (useTurn.errorLines.length > 0) {
    const lastError = useTurn.toolLines.lastIndexOf(
      useTurn.errorLines[useTurn.errorLines.length - 1]!,
    );
    const recovered = useTurn.toolLines
      .slice(lastError + 1)
      .some((l) => !l.includes("-> ERROR"));
    if (!recovered && useTurn.checks.length === 0) {
      if (verdict === "PASS") verdict = "SUSPECT";
      notes.push(`tool errors sem recuperação: ${useTurn.errorLines.length}`);
    } else {
      notes.push(`tool errors recuperados: ${useTurn.errorLines.length}`);
    }
  }

  // Nenhuma tool no turno de uso (feats ativos deveriam gerar mecânica).
  if (
    s.side === "combat" &&
    s.actionType === "action" &&
    useTurn.toolLines.length === 0
  ) {
    if (verdict === "PASS") verdict = "SUSPECT";
    notes.push("nenhuma tool chamada no turno de uso de um feat com custo de ação");
  }

  // Fora de combate: uso ativo sem nenhum check nem update_state → suspeito.
  // skill-activity e downtime são ATIVIDADES por definição (exigem mecânica
  // mesmo quando o Foundry as marca actionType "passive" — caso Sow Rumor).
  const isActivity =
    s.archetype === "skill-activity" || s.archetype === "downtime";
  if (
    s.side === "noncombat" &&
    (isActivity || s.actionType !== "passive") &&
    useTurn.checks.length === 0 &&
    !toolsUsed.includes("update_state")
  ) {
    if (verdict === "PASS") verdict = "SUSPECT";
    notes.push("feat ativo fora de combate resolvido sem mecânica alguma");
  }

  return {
    feat: s.name,
    side: s.side,
    archetype: s.archetype,
    verdict,
    actionsSpent,
    toolsUsed,
    notes,
    seconds: turns.reduce((a, t) => a + t.seconds, 0),
  };
}

// ---------------------------------------------------------------------------
// Progresso + relatório
// ---------------------------------------------------------------------------

type Progress = Record<string, Verdict>;

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
  const lines = [
    `# Feat audit — ${date}`,
    "",
    `${all.length} cenários | PASS ${count("PASS")} · FAIL ${count("FAIL")} · SUSPECT ${count("SUSPECT")}`,
    "",
  ];
  const byArch = new Map<string, Verdict[]>();
  for (const r of all) {
    const key = `${r.side} / ${r.archetype}`;
    byArch.set(key, [...(byArch.get(key) ?? []), r]);
  }
  for (const [arch, list] of byArch) {
    lines.push(`## ${arch}`, "", "| Feat | Veredito | Ações | Tools | Notas |", "|---|---|---|---|---|");
    for (const r of list) {
      lines.push(
        `| ${r.feat} | ${r.verdict} | ${r.actionsSpent ?? "—"} | ${r.toolsUsed.join(", ") || "—"} | ${r.notes.join("; ") || "—"} |`,
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
        const verdict = judge(s, turns);
        progress[s.name] = verdict;
        const slug = s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
        writeFileSync(
          join(TRANSCRIPTS, `${slug}.json`),
          JSON.stringify({ scenario: s, turns, verdict }, null, 1),
        );
        console.log(
          `${verdict.verdict} (${Math.round((Date.now() - started) / 1000)}s)${
            verdict.notes.length ? ` — ${verdict.notes[0]}` : ""
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
