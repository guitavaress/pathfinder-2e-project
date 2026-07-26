/**
 * Re-julga os transcripts JÁ GRAVADOS com o juiz atual e mostra o que mudou.
 *
 * Por que existe: mudar o juiz sem rodar a bateria custa zero GPU — os
 * transcripts em `transcripts/*.json` guardam turnos completos (tool lines,
 * checks, estado final, narrativa), que é exatamente o que `judge()` consome.
 * Toda alteração no juiz deve passar por aqui ANTES de gastar 44 min de bateria:
 * é assim que se separa "o juiz mudou de opinião" de "o jogo mudou".
 *
 * Uso:  npx tsx scripts/feat-audit/replay-judge.ts [--diff-only]
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { judge, type Scenario, type TurnResult, type Verdict } from "./judge.js";

const here = dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS = join(here, "transcripts");
const DIFF_ONLY = process.argv.includes("--diff-only");

interface Stored {
  scenario: Scenario;
  turns: TurnResult[];
  verdict: Verdict;
}

const files = readdirSync(TRANSCRIPTS)
  .filter((f) => f.endsWith(".json") && !f.startsWith("ally-"))
  .sort();

let changed = 0;
const tally = { PASS: 0, FAIL: 0, SUSPECT: 0 };
const usageTally = { confirmed: 0, missing: 0, "not-asserted": 0 };
const rows: string[] = [];

for (const file of files) {
  let stored: Stored;
  try {
    stored = JSON.parse(readFileSync(join(TRANSCRIPTS, file), "utf8")) as Stored;
  } catch {
    console.warn(`  (ignorado, ilegível: ${file})`);
    continue;
  }
  if (!stored.scenario || !stored.turns?.length) continue;

  const now = judge(stored.scenario, stored.turns);
  const before = stored.verdict?.verdict ?? "?";
  tally[now.verdict]++;
  usageTally[now.usage.kind]++;

  if (before !== now.verdict) {
    changed++;
    rows.push(
      `  ${before} → ${now.verdict}  ${stored.scenario.name} ` +
        `[${stored.scenario.actionType ?? "?"}] — ${now.notes.join("; ") || "—"}`,
    );
  } else if (!DIFF_ONLY) {
    const u = now.usage.kind === "confirmed" ? "✅" : now.usage.kind === "missing" ? "❌" : "—";
    rows.push(`  ${now.verdict.padEnd(7)} ${u} ${stored.scenario.name}`);
  }
}

console.log(`Re-julgados ${files.length} transcripts com o juiz atual.\n`);
if (rows.length) console.log(rows.join("\n"), "\n");
console.log(
  `Vereditos agora: PASS ${tally.PASS} · FAIL ${tally.FAIL} · SUSPECT ${tally.SUSPECT}`,
);
console.log(
  `Asserção de uso: confirmado ${usageTally.confirmed} · ausente ${usageTally.missing} · ` +
    `sem asserção ${usageTally["not-asserted"]} ` +
    `(cobertura ${usageTally.confirmed + usageTally.missing}/${files.length})`,
);
console.log(`Vereditos que MUDARAM em relação ao gravado: ${changed}`);
