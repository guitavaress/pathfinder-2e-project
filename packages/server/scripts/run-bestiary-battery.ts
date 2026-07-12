/**
 * Bateria GPU do backlog de combate (PR #8): bestiary real, dano persistente,
 * reações e casters — modelo + engine de ponta a ponta, nos moldes do
 * feat-audit (servidor temporário na :3101, morto ao final; transcripts).
 *
 * SÓ RODA COM OK EXPLÍCITO DO USUÁRIO (usa GPU/LM Studio).
 *
 * Uso: npx tsx scripts/run-bestiary-battery.ts [--case=id] [--port=3101]
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = join(here, "..");
const EXAMPLE_CHAR = join(SERVER_DIR, "../../exemplo_personagem.json");
const TRANSCRIPTS = join(here, "bestiary-battery-transcripts");

const argv = process.argv.slice(2);
const ONLY_CASE = argv.find((a) => a.startsWith("--case="))?.split("=")[1];
const PORT = Number(argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 3101);
const BASE = `http://localhost:${PORT}`;

// ---------------------------------------------------------------------------
// Personagens-template
// ---------------------------------------------------------------------------

/** Jão (Rogue 5) com consumíveis garantidos para os cenários. */
function martialCharacter(): unknown {
  const doc = JSON.parse(readFileSync(EXAMPLE_CHAR, "utf8")) as {
    build: Record<string, unknown>;
  };
  const equipment = (doc.build.equipment ?? []) as unknown[][];
  equipment.push(["Alchemist's Fire (Lesser)", 2], ["Healing Potion (Minor)", 2]);
  doc.build.equipment = equipment;
  return doc;
}

/** Mesmo template com um caster arcano espontâneo injetado (Fireball/Ignition). */
function casterCharacter(): unknown {
  const doc = JSON.parse(readFileSync(EXAMPLE_CHAR, "utf8")) as {
    build: Record<string, unknown>;
  };
  doc.build.name = "Vesper";
  doc.build.spellCasters = [
    {
      name: "Arcane Spontaneous Spells",
      magicTradition: "arcane",
      spellcastingType: "spontaneous",
      ability: "int",
      proficiency: 2,
      attack: 11,
      dc: 21,
      perDay: [0, 0, 0, 2],
      spells: [
        { spellLevel: 0, list: ["Ignition", "Telekinetic Projectile"] },
        { spellLevel: 3, list: ["Fireball"] },
      ],
    },
  ];
  return doc;
}

// ---------------------------------------------------------------------------
// Cenários (espelham scripts/bestiary-battery.json, com turnos concretos)
// ---------------------------------------------------------------------------

interface CheckEv {
  label: string;
  degree: string;
  attack?: { attacker: string; target: string; outcome: string } | null;
}
interface TurnResult {
  input: string;
  narrative: string;
  checks: CheckEv[];
  states: Record<string, unknown>[];
  toolLines: string[];
  errorLines: string[];
  seconds: number;
}
interface Verdict {
  id: string;
  verdict: "PASS" | "FAIL" | "SUSPECT";
  notes: string[];
  seconds: number;
}

type Enemy = Record<string, unknown>;
const allEnemies = (turns: TurnResult[]): Enemy[] => {
  const out = new Map<string, Enemy>();
  for (const t of turns) {
    for (const st of t.states) {
      const combat = (st as { combat?: { combatants?: Enemy[] } }).combat;
      for (const c of combat?.combatants ?? []) {
        if (c.kind === "enemy") out.set(String(c.id), c);
      }
    }
  }
  return [...out.values()];
};
const allChecks = (turns: TurnResult[]): CheckEv[] => turns.flatMap((t) => t.checks);
const allConditions = (turns: TurnResult[]): string[] => {
  const out: string[] = [];
  for (const t of turns) {
    for (const st of t.states) {
      const combat = (st as { combat?: { combatants?: Enemy[] } }).combat;
      for (const c of combat?.combatants ?? []) {
        out.push(...((c.conditions as string[]) ?? []));
      }
      out.push(...(((st as { conditions?: string[] }).conditions) ?? []));
    }
  }
  return out;
};

interface Scenario {
  id: string;
  character: () => unknown;
  turns: string[];
  judge: (turns: TurnResult[]) => { verdict: Verdict["verdict"]; notes: string[] };
}

const SCENARIOS: Scenario[] = [
  {
    id: "giant-rats-cellar",
    character: martialCharacter,
    turns: [
      "I kick open the cellar door, daggers drawn — two giant rats charge me!",
      "I strike the nearest giant rat with my dagger!",
    ],
    judge(turns) {
      const notes: string[] = [];
      const rat = allEnemies(turns).find((e) => e.sourceName === "Giant Rat");
      if (!rat) return { verdict: "FAIL", notes: ["nenhum inimigo com sourceName Giant Rat"] };
      if (rat.ac !== 15 || rat.maxHp !== 8 || rat.level !== -1) {
        return { verdict: "FAIL", notes: [`stats errados: AC ${rat.ac}, HP ${rat.maxHp}, lvl ${rat.level}`] };
      }
      const jaws = allChecks(turns).some((c) => c.label.includes("Jaws"));
      if (!jaws) notes.push("revide com Jaws não observado (rato pode ter morrido antes)");
      return { verdict: jaws ? "PASS" : "SUSPECT", notes };
    },
  },
  {
    id: "goblin-warriors-ambush",
    character: martialCharacter,
    turns: [
      "Two goblin warriors leap from the rocks and attack me on the trail!",
      "I stab the nearest goblin warrior with my dagger!",
    ],
    judge(turns) {
      const gw = allEnemies(turns).find((e) => e.sourceName === "Goblin Warrior");
      if (!gw) return { verdict: "FAIL", notes: ["sem sourceName Goblin Warrior"] };
      if (gw.ac !== 16 || gw.maxHp !== 6) {
        return { verdict: "FAIL", notes: [`stats errados: AC ${gw.ac}, HP ${gw.maxHp}`] };
      }
      const dog = allChecks(turns).some((c) => c.label.includes("Dogslicer"));
      return dog
        ? { verdict: "PASS", notes: [] }
        : { verdict: "SUSPECT", notes: ["Dogslicer não observado no revide"] };
    },
  },
  {
    id: "wolf-night-attack",
    character: martialCharacter,
    turns: [
      "A wolf stalks out of the treeline, growling, and lunges at my throat!",
      "I slash at the wolf with my dagger!",
    ],
    judge(turns) {
      const wolf = allEnemies(turns).find((e) => e.sourceName === "Wolf");
      if (!wolf) return { verdict: "FAIL", notes: ["sem sourceName Wolf"] };
      return wolf.level === 1
        ? { verdict: "PASS", notes: [] }
        : { verdict: "FAIL", notes: [`nível errado: ${wolf.level}`] };
    },
  },
  {
    id: "skeleton-guard-crypt",
    character: martialCharacter,
    turns: [
      "I pry open the sarcophagus — a skeleton guard rises, sword in hand, and attacks!",
      "I strike the skeleton guard!",
    ],
    judge(turns) {
      const sk = allEnemies(turns).find((e) => e.sourceName === "Skeleton Guard");
      if (!sk) return { verdict: "FAIL", notes: ["sem sourceName Skeleton Guard"] };
      return sk.level === -1
        ? { verdict: "PASS", notes: [] }
        : { verdict: "FAIL", notes: [`nível errado: ${sk.level}`] };
    },
  },
  {
    id: "invented-thug-fallback",
    character: martialCharacter,
    turns: ["A dockside thug swings a club at my head — I fight back and strike him!"],
    judge(turns) {
      const foes = allEnemies(turns);
      if (foes.length === 0) return { verdict: "SUSPECT", notes: ["combate não começou"] };
      const bound = foes.find((e) => e.sourceName);
      return bound
        ? { verdict: "FAIL", notes: [`nome genérico ligou a ${bound.sourceName}`] }
        : { verdict: "PASS", notes: [] };
    },
  },
  {
    id: "persistent-fire-tick",
    character: martialCharacter,
    turns: [
      "Two giant rats burst from the cellar and attack me!",
      "I throw my alchemist's fire at one of the giant rats!",
      "I strike the burning rat again!",
    ],
    judge(turns) {
      const usedItem = turns.some((t) => t.toolLines.some((l) => l.includes("use_item")));
      if (!usedItem) return { verdict: "SUSPECT", notes: ["modelo não chamou use_item"] };
      const persistent = allConditions(turns).some((c) => /persistent\s+fire\s+damage/i.test(c));
      if (!persistent) {
        return { verdict: "SUSPECT", notes: ["condição persistent fire não observada (bomba errou?)"] };
      }
      return { verdict: "PASS", notes: [] };
    },
  },
  {
    id: "reactive-strike-on-potion",
    character: martialCharacter,
    turns: [
      "A skeletal champion rises from the crypt, blade drawn, and attacks me!",
      "I drink my healing potion!",
    ],
    judge(turns) {
      const champ = allEnemies(turns).find((e) => e.sourceName === "Skeletal Champion");
      if (!champ) return { verdict: "SUSPECT", notes: ["Skeletal Champion não entrou (nome trocado?)"] };
      const reaction = allChecks(turns).some((c) => c.label.includes("Reaction ("));
      if (!reaction) {
        const drank = turns.some((t) => t.toolLines.some((l) => l.includes("use_item")));
        return drank
          ? { verdict: "FAIL", notes: ["poção bebida sem disparar Reactive Strike"] }
          : { verdict: "SUSPECT", notes: ["modelo não usou a poção"] };
      }
      return { verdict: "PASS", notes: [] };
    },
  },
  {
    id: "enemy-caster-once",
    character: martialCharacter,
    turns: [
      "A goblin war chanter blocks the path, chanting an eerie tune — I attack it with my dagger!",
      "I keep pressing the attack on the war chanter!",
    ],
    judge(turns) {
      const wc = allEnemies(turns).find((e) => e.sourceName === "Goblin War Chanter");
      if (!wc) return { verdict: "SUSPECT", notes: ["war chanter não entrou com statblock"] };
      const castChecks = (t: TurnResult) =>
        t.checks.filter((c) => c.label.includes("Telekinetic Projectile")).length;
      const casts1 = castChecks(turns[0]!);
      const casts2 = turns[1] ? castChecks(turns[1]) : 0;
      if (casts1 + casts2 === 0) {
        return { verdict: "SUSPECT", notes: ["não conjurou (morreu antes do turno dele?)"] };
      }
      if (casts1 + casts2 > 1) {
        return { verdict: "FAIL", notes: [`conjurou ${casts1 + casts2}× (limite 1/combate)`] };
      }
      return { verdict: "PASS", notes: [] };
    },
  },
  {
    id: "player-cast-fireball",
    character: casterCharacter,
    turns: [
      "Three giant rats swarm out of the drain and surround me!",
      "I cast Fireball on the rats!",
    ],
    judge(turns) {
      const cast = turns.some((t) => t.toolLines.some((l) => l.includes("cast_spell")));
      if (!cast) return { verdict: "FAIL", notes: ["modelo não chamou cast_spell"] };
      const lastState = turns.at(-1)?.states.at(-1) as
        | { spellSlotsUsed?: Record<string, number> }
        | undefined;
      const slot = lastState?.spellSlotsUsed?.["3"] ?? 0;
      if (slot !== 1) return { verdict: "FAIL", notes: [`slot rank 3 gasto ${slot}× (esperado 1)`] };
      const saves = allChecks(turns).filter((c) => /reflex.*save/i.test(c.label)).length;
      return saves >= 2
        ? { verdict: "PASS", notes: [] }
        : { verdict: "SUSPECT", notes: [`só ${saves} saves de reflex observados`] };
    },
  },
  {
    id: "player-cast-unknown-spell",
    character: casterCharacter,
    turns: [
      "A giant rat scurries out of the drain and bites at my boots!",
      "I cast Disintegrate at the giant rat!",
    ],
    judge(turns) {
      const rejected = turns.some((t) =>
        t.errorLines.some((l) => l.includes("cast_spell")),
      );
      if (!rejected) {
        const tried = turns.some((t) => t.toolLines.some((l) => l.includes("cast_spell")));
        return tried
          ? { verdict: "FAIL", notes: ["cast_spell de magia desconhecida NÃO foi rejeitado"] }
          : { verdict: "SUSPECT", notes: ["modelo nem tentou cast_spell"] };
      }
      const lastState = turns.at(-1)?.states.at(-1) as
        | { spellSlotsUsed?: Record<string, number> }
        | undefined;
      const spent = Object.values(lastState?.spellSlotsUsed ?? {}).reduce((a, b) => a + b, 0);
      return spent === 0
        ? { verdict: "PASS", notes: [] }
        : { verdict: "FAIL", notes: [`slot gasto em cast rejeitado (${spent})`] };
    },
  },
];

// ---------------------------------------------------------------------------
// Servidor temporário (idêntico ao feat-audit: grupo próprio, morto no fim)
// ---------------------------------------------------------------------------

let serverProc: ChildProcess | null = null;
let serverLog = "";

async function startServer(): Promise<void> {
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
  const states: Record<string, unknown>[] = [];
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
          else if (ev.type === "state") states.push(ev.state);
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
  return {
    input: text,
    narrative,
    checks,
    states,
    toolLines,
    errorLines: toolLines.filter((l) => l.includes("-> ERROR")),
    seconds: Math.round((Date.now() - started) / 1000),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const pending = SCENARIOS.filter((s) => !ONLY_CASE || s.id === ONLY_CASE);
  mkdirSync(TRANSCRIPTS, { recursive: true });
  await startServer();
  console.log(`Servidor de teste em ${BASE}. ${pending.length} cenários.\n`);

  const results: Verdict[] = [];
  try {
    for (const [i, s] of pending.entries()) {
      const started = Date.now();
      process.stdout.write(`[${i + 1}/${pending.length}] ${s.id} ... `);
      try {
        const imp = await fetch(`${BASE}/character/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(s.character()),
        });
        if (!imp.ok) throw new Error(`import ${imp.status}: ${await imp.text()}`);
        const { sessionId } = (await imp.json()) as { sessionId: string };
        const turns: TurnResult[] = [];
        for (const input of s.turns) turns.push(await runTurn(sessionId, input));
        const { verdict, notes } = s.judge(turns);
        const seconds = Math.round((Date.now() - started) / 1000);
        results.push({ id: s.id, verdict, notes, seconds });
        writeFileSync(
          join(TRANSCRIPTS, `${s.id}.json`),
          JSON.stringify({ id: s.id, turns, verdict, notes }, null, 1),
        );
        console.log(`${verdict} (${seconds}s)${notes.length ? ` — ${notes[0]}` : ""}`);
      } catch (err) {
        results.push({
          id: s.id,
          verdict: "SUSPECT",
          notes: [`erro do harness: ${(err as Error).message.slice(0, 120)}`],
          seconds: Math.round((Date.now() - started) / 1000),
        });
        console.log(`ERRO — ${(err as Error).message.slice(0, 80)}`);
      }
    }
  } finally {
    stopServer();
  }

  const pass = results.filter((r) => r.verdict === "PASS").length;
  const fail = results.filter((r) => r.verdict === "FAIL").length;
  const susp = results.filter((r) => r.verdict === "SUSPECT").length;
  console.log(`\nResultado: ${pass} PASS, ${fail} FAIL, ${susp} SUSPECT.`);
  console.log(`Transcripts em ${TRANSCRIPTS}`);
  if (fail > 0) process.exitCode = 1;
}

main().catch((err) => {
  stopServer();
  console.error("Bateria falhou:", err);
  process.exit(1);
});
