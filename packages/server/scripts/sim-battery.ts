/**
 * BATERIA DE SIMULAÇÃO — um dia de aventura inteiro, sem GPU e sem modelo.
 *
 * Por que existe: play-test é caro e nem sempre possível, e a suíte unitária
 * afirma coisas pequenas sobre estados montados à mão. Esta bateria pega
 * personagens de NÍVEL 20 gerados do dataset real (o pior caso: mais feats,
 * mais magias, números maiores), joga um dia de aventura completo contra
 * criaturas OFICIAIS do bestiary, e verifica INVARIANTES a cada passo.
 *
 * Ela não substitui o play-test — não julga se o jogo é divertido, nem se o
 * narrador é bom. Ela responde uma pergunta só, que é a que importa antes de
 * mergear: **a engine se contradiz em algum momento?**
 *
 * 100% determinística: mesma seed, mesmo resultado. Sem llama-server, sem rede.
 *
 * Uso:
 *   npx tsx scripts/sim-battery.ts                    # 12 personagens, seed 2026
 *   npx tsx scripts/sim-battery.ts --chars=30         # mais fichas
 *   npx tsx scripts/sim-battery.ts --seed=99 --verbose
 *   npx tsx scripts/sim-battery.ts --level=1          # outro nível
 *
 * Sai com código 1 se qualquer invariante for violada — serve de gate de PR.
 */
import type { Character, Combatant } from "@pf2e/shared";
import { executeTool, resolveRoundEnd, type StreamEvent } from "../src/gm/agent.js";
import { beginPlayerRound } from "../src/gm/combat.js";
import { makeCorpusCharacter } from "../src/rules/corpus.js";
import { auditCharacter } from "../src/rules/coverage.js";
import { categoryRecords } from "../src/rules/dataset.js";
import { officialConditions } from "../src/rules/dataset.js";
import type { Session } from "../src/gm/sessions.js";

// ─────────────────────────── argumentos ───────────────────────────

const arg = (name: string, fallback: number): number => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? Number(hit.split("=")[1]) : fallback;
};
const CHARS = arg("chars", 12);
const SEED = arg("seed", 2026);
const LEVEL = arg("level", 20);
const VERBOSE = process.argv.includes("--verbose");

// ─────────────────────────── invariantes ───────────────────────────

interface Violation {
  character: string;
  step: string;
  invariant: string;
  detail: string;
}

const violations: Violation[] = [];
let checks = 0;

function check(
  ok: boolean,
  character: string,
  step: string,
  invariant: string,
  detail: string,
): void {
  checks++;
  if (!ok) violations.push({ character, step, invariant, detail });
}

const CONDITIONS = officialConditions();

/**
 * As invariantes que valem para QUALQUER ficha em QUALQUER passo.
 *
 * São afirmações sobre coerência, não sobre valores: "HP não passa do máximo"
 * vale para todo personagem; "o modificador é 15" só vale para o do autor — e
 * foi assim que a suíte virou refém de um Goblin Rogue 5.
 */
function checkState(session: Session, who: string, step: string): void {
  const s = session.state;
  const max = session.character.maxHp;

  check(
    Number.isFinite(s.currentHp) && s.currentHp >= 0 && s.currentHp <= max,
    who,
    step,
    "HP do jogador dentro de [0, maxHp]",
    `currentHp=${s.currentHp} maxHp=${max}`,
  );

  for (const c of s.conditions ?? []) {
    const base = c.replace(/\s+\d+$/, "").toLowerCase();
    check(
      CONDITIONS.has(base),
      who,
      step,
      "condição do jogador é oficial",
      `"${c}"`,
    );
  }

  const combat = s.combat;
  if (!combat) return;

  check(
    combat.turnIndex >= 0 && combat.turnIndex < combat.combatants.length,
    who,
    step,
    "turnIndex aponta para um combatente existente",
    `turnIndex=${combat.turnIndex} de ${combat.combatants.length}`,
  );

  for (const c of combat.combatants) {
    check(
      Number.isFinite(c.currentHp) && c.currentHp >= 0 && c.currentHp <= c.maxHp,
      who,
      step,
      "HP de combatente dentro de [0, maxHp]",
      `${c.name}: ${c.currentHp}/${c.maxHp}`,
    );
    check(
      c.actionsRemaining >= 0 && c.actionsRemaining <= 3,
      who,
      step,
      "ações entre 0 e 3",
      `${c.name}: ${c.actionsRemaining}`,
    );
    check(
      c.mapProgress >= 0 && c.mapProgress <= 12,
      who,
      step,
      "MAP não dispara para valores absurdos",
      `${c.name}: ${c.mapProgress}`,
    );
    check(
      !(c.currentHp === 0 && !c.defeated && c.kind !== "player"),
      who,
      step,
      "inimigo/aliado a 0 HP está marcado como derrotado",
      `${c.name}: hp=0 defeated=${c.defeated}`,
    );
    check(
      !(c.defeated && c.currentHp > 0),
      who,
      step,
      "combatente derrotado não tem HP sobrando",
      `${c.name}: hp=${c.currentHp} defeated=true`,
    );
  }

  for (const e of s.effects ?? []) {
    check(
      typeof e.slug === "string" && e.slug.length > 0,
      who,
      step,
      "efeito ativo tem slug",
      JSON.stringify(e).slice(0, 80),
    );
  }
}

/** Um resultado de tool nunca é "sucesso vazio": ou resolve, ou explica. */
function checkOutcome(
  out: { content: string; isError?: boolean; summaryLine?: string },
  who: string,
  step: string,
): void {
  check(
    typeof out.content === "string" && out.content.trim().length > 0,
    who,
    step,
    "toda tool devolve conteúdo não vazio",
    JSON.stringify(out).slice(0, 100),
  );
}

// ─────────────────────────── cenário ───────────────────────────

const noop = () => {};

function sessionFor(c: Character): Session {
  return {
    id: `sim-${c.name}`,
    character: c,
    state: {
      sessionId: `sim-${c.name}`,
      currentHp: c.maxHp,
      conditions: [],
      flags: {},
      combat: null,
      effects: [],
    },
  } as unknown as Session;
}

/** Criaturas OFICIAIS perto do nível do personagem (statblock real, não boneco). */
function foesNear(level: number): string[] {
  return categoryRecords("bestiary")
    .filter((r) => r.statblock && Math.abs((r.level ?? 0) - level) <= 2)
    .map((r) => r.name)
    .sort();
}

interface Result {
  character: string;
  build: string;
  turns: number;
  rolls: number;
  rejections: number;
  declared: number;
  outcome: string;
  coverage: { mechanized: number; declared: number; blind: number };
}

/**
 * Um dia de aventura: combate contra criatura oficial, magia, item, descanso.
 * Cada passo verifica o estado inteiro depois de rodar.
 */
async function playDay(c: Character, foePool: string[], seedIdx: number): Promise<Result> {
  const s = sessionFor(c);
  const who = `${c.name} (${c.className} ${c.level})`;
  let rolls = 0;
  let rejections = 0;
  let declared = 0;
  let turns = 0;

  const events: StreamEvent[] = [];
  const emit = (e: StreamEvent) => {
    events.push(e);
    if (e.type === "check") rolls++;
    if (e.type === "adjudicated") declared++;
  };

  const run = async (tool: string, args: Record<string, unknown>, step: string) => {
    const out = await executeTool(s, tool, args, emit);
    checkOutcome(out, who, step);
    checkState(s, who, step);
    if (out.isError) rejections++;
    if (VERBOSE) {
      console.log(`    ${out.isError ? "REJ " : "ok  "}${step}: ${out.content.slice(0, 96)}`);
    }
    return out;
  };

  // 1. COMBATE contra duas criaturas oficiais do nível certo.
  const foeA = foePool[(seedIdx * 7) % foePool.length]!;
  const foeB = foePool[(seedIdx * 13 + 5) % foePool.length]!;
  await run("start_combat", { enemies: [{ name: foeA }, { name: foeB }] }, "start_combat");
  checkState(s, who, "pós start_combat");

  // Até 8 rodadas: o jogador ataca com o que tem, o inimigo revida em código.
  for (let round = 0; round < 8; round++) {
    const combat = s.state.combat;
    if (!combat?.active) break;
    const you = combat.combatants.find((x) => x.kind === "player");
    if (!you || you.defeated) break;
    const target = combat.combatants.find((x) => x.kind === "enemy" && !x.defeated);
    if (!target) break;
    turns++;
    // No jogo, 1 mensagem do jogador = 1 turno, e o rules stage abre a mensagem
    // com `beginPlayerRound` (renova ações, zera MAP, devolve reação). Pular
    // isto — como o primeiro rascunho fazia — deixava o jogador com 0 ações da
    // rodada 2 em diante e a bateria media um personagem paralisado.
    beginPlayerRound(combat);

    // Três ações. Conjurador gasta a magia PRIMEIRO: uma magia de 3 ações
    // (Antimagic Field) depois de dois golpes é corretamente rejeitada pela
    // economia de ação, e a bateria mediria a rejeição em vez da conjuração.
    // Um jogador de verdade também não faria isso.
    const weapon = c.weapons[0]!.name;
    const spell = c.spellcasting[0]?.spells[0];
    if (spell) {
      await run("cast_spell", { spell, target: target.name }, `r${round + 1} magia`);
    }
    const strikes = spell ? 1 : 3;
    for (let n = 0; n < strikes; n++) {
      const you2 = combat.combatants.find((x) => x.kind === "player");
      if (!you2 || you2.actionsRemaining <= 0 || you2.defeated) break;
      await run(
        "roll_check",
        {
          skill: weapon,
          target: target.name,
          reason: `golpe ${round + 1}.${n + 1}`,
          dc: target.ac,
        },
        `r${round + 1} strike ${n + 1}`,
      );
    }

    await run("end_turn", {}, `r${round + 1} end_turn`);
    // A MESMA função que o rules stage chama: aliados, revide inimigo, dano
    // persistente e upkeep (é aqui que as ações do jogador renovam). Chamar só
    // `resolveEnemyTurns`, como o primeiro rascunho fazia, deixava o jogador
    // com 0 ações na rodada seguinte e a bateria media uma ficção.
    resolveRoundEnd(s, emit);
    checkState(s, who, `r${round + 1} pós-revide`);
  }

  const combatEnd = s.state.combat;
  const outcome = !combatEnd?.active
    ? "combate encerrado"
    : combatEnd.combatants.find((x) => x.kind === "player")?.defeated
      ? "jogador caído"
      : "limite de rodadas";

  if (s.state.combat?.active) {
    await run("end_combat", { reason: "fim da simulação" }, "end_combat");
  }

  // 2. CONDIÇÃO aplicada pela engine, e removida.
  await run("update_state", { addConditions: ["frightened 2"] }, "aplica condição");
  await run("update_state", { removeConditions: ["frightened"] }, "remove condição");

  // 3. ITEM que a ficha NÃO tem — a engine tem de rejeitar, não inventar.
  await run("use_item", { item: "Elixir Inexistente", reason: "bebe" }, "item inexistente");

  // 4. DESCANSO: cura pelas regras reais, e efeitos não sobrevivem.
  await run("rest", { kind: "overnight" }, "descanso");
  check(
    (s.state.effects ?? []).length === 0,
    who,
    "descanso",
    "nenhum efeito sobrevive ao descanso",
    `${(s.state.effects ?? []).length} efeito(s)`,
  );

  const cov = auditCharacter(c).counts;
  return {
    character: c.name,
    build: `${c.className} ${c.level} · ${c.feats.length} feats · ${c.spellcasting[0]?.spells.length ?? 0} magias`,
    turns,
    rolls,
    rejections,
    declared,
    outcome,
    coverage: cov,
  };
}

// ─────────────────────────── relatório ───────────────────────────

async function main() {
  const started = Date.now();
  console.log(
    `\nBATERIA DE SIMULAÇÃO — ${CHARS} personagens nível ${LEVEL}, seed ${SEED}, sem GPU\n` +
      `${"─".repeat(78)}`,
  );

  const foePool = foesNear(LEVEL);
  console.log(`Inimigos: ${foePool.length} criaturas oficiais do bestiary nv ${LEVEL}±2\n`);

  const results: Result[] = [];
  for (let i = 0; i < CHARS; i++) {
    const c = makeCorpusCharacter({ seed: SEED + i * 7919, level: LEVEL });
    if (VERBOSE) console.log(`\n  ${c.name} — ${c.className} ${c.level}`);
    results.push(await playDay(c, foePool, i));
  }

  console.log(`${"─".repeat(78)}`);
  console.log(
    `${"personagem".padEnd(16)}${"build".padEnd(34)}${"turnos".padStart(7)}${"rolagens".padStart(9)}${"rej".padStart(5)}  desfecho`,
  );
  for (const r of results) {
    console.log(
      `${r.character.padEnd(16)}${r.build.slice(0, 33).padEnd(34)}${String(r.turns).padStart(7)}${String(r.rolls).padStart(9)}${String(r.rejections).padStart(5)}  ${r.outcome}`,
    );
  }

  const sum = (f: (r: Result) => number) => results.reduce((a, r) => a + f(r), 0);
  const cov = {
    mechanized: sum((r) => r.coverage.mechanized),
    declared: sum((r) => r.coverage.declared),
    blind: sum((r) => r.coverage.blind),
  };
  const covTotal = cov.mechanized + cov.declared + cov.blind || 1;
  const pct = (n: number) => `${((n / covTotal) * 100).toFixed(1)}%`;

  console.log(`${"─".repeat(78)}`);
  console.log(
    `TOTAIS: ${sum((r) => r.turns)} turnos · ${sum((r) => r.rolls)} rolagens · ` +
      `${sum((r) => r.rejections)} rejeições · ${sum((r) => r.declared)} declarações`,
  );
  console.log(
    `COBERTURA das fichas: MECANIZADO ${pct(cov.mechanized)} · ` +
      `DECLARADO ${pct(cov.declared)} · CEGO ${pct(cov.blind)}`,
  );
  console.log(
    `INVARIANTES: ${checks} verificações, ${violations.length} violação(ões) · ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s`,
  );

  if (violations.length === 0) {
    console.log(`\n✓ A engine não se contradisse em nenhum passo.\n`);
    console.log(
      `  (Isto NÃO diz que o jogo está bom — diz que o estado é coerente.\n` +
        `   Julgar cena, ritmo e voz continua exigindo play-test.)\n`,
    );
    return;
  }

  console.log(`\n✗ ${violations.length} VIOLAÇÃO(ÕES) DE INVARIANTE\n`);
  const byInvariant = new Map<string, Violation[]>();
  for (const v of violations) {
    byInvariant.set(v.invariant, [...(byInvariant.get(v.invariant) ?? []), v]);
  }
  for (const [inv, vs] of [...byInvariant].sort((a, b) => b[1].length - a[1].length)) {
    console.log(`  ${vs.length}× ${inv}`);
    for (const v of vs.slice(0, 3)) {
      console.log(`      ${v.character} · ${v.step} · ${v.detail}`);
    }
    if (vs.length > 3) console.log(`      … e mais ${vs.length - 3}`);
  }
  console.log();
  process.exitCode = 1;
}

main().catch((err) => {
  console.error("\n✗ A bateria EXPLODIU (isto já é o achado):\n", err);
  process.exitCode = 1;
});
