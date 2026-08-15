/**
 * A fronteira do que a engine executa, medida sobre fichas ARBITRÁRIAS.
 *
 * Este arquivo responde à pergunta que motivou a branch: "por que cada
 * personagem novo revela bugs?". Resposta medida: porque a suíte só media três
 * fichas feitas à mão, e a fronteira do implementado nunca era exercida.
 *
 * O invariante daqui é **teto congelado**, não "zero CEGO". Exigir zero seria
 * desonesto: 52,6% dos feats do PF2e são prosa pura em qualquer fonte (60% dos
 * de classe), e nenhum código fecha isso. O que dá para exigir é que o balde
 * CEGO **não cresça** — e a linha [T9] mostra a cada `npm test` para onde ele
 * está indo.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { auditCharacter, datasetCoverageCensus, type CoverageVerdict } from "./coverage.js";
import { makeCorpus, makeCorpusCharacter } from "./corpus.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));

/**
 * TETO CONGELADO — medido em 2026-08-15 sobre 60 fichas geradas (seed 1234).
 *
 * Só pode DESCER. Se subir, alguma mudança tornou a engine mais silenciosa e o
 * teste tem de acusar antes do play-test. Se descer bastante, baixe o número no
 * mesmo commit que causou a melhora — teto frouxo não mede nada.
 */
const BLIND_CEILING = 0.62; // medido: 61,3%
const CORPUS_SIZE = 60;
const CORPUS_SEED = 1234;

describe.skipIf(!hasGenerated)("cobertura de ficha (requer generated/)", () => {
  const corpus = makeCorpus(CORPUS_SEED, CORPUS_SIZE);

  it("a engine audita QUALQUER ficha sem explodir", () => {
    // O que a suíte nunca teve: entrada que ninguém escolheu a dedo.
    for (const c of corpus) {
      expect(() => auditCharacter(c), `ficha ${c.name} (${c.className} ${c.level})`).not.toThrow();
    }
  });

  it("[T9] mede a fronteira do implementado", () => {
    const totals: Record<CoverageVerdict, number> = { mechanized: 0, declared: 0, blind: 0 };
    const blindReasons = new Map<string, number>();
    let entries = 0;

    for (const c of corpus) {
      const report = auditCharacter(c);
      entries += report.entries.length;
      for (const v of ["mechanized", "declared", "blind"] as const) {
        totals[v] += report.counts[v];
      }
      for (const e of report.entries) {
        if (e.verdict !== "blind") continue;
        const bucket = e.reason.replace(/\(.*\)/, "(…)");
        blindReasons.set(bucket, (blindReasons.get(bucket) ?? 0) + 1);
      }
    }

    const pct = (n: number) => `${((n / entries) * 100).toFixed(1)}%`;
    const top = [...blindReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
    console.log(
      `[T9] cobertura de ficha: ${CORPUS_SIZE} fichas geradas, ${entries} entradas | ` +
        `MECANIZADO ${totals.mechanized} (${pct(totals.mechanized)}) | ` +
        `DECLARADO ${totals.declared} (${pct(totals.declared)}) | ` +
        `CEGO ${totals.blind} (${pct(totals.blind)})`,
    );
    console.log(
      `[T9] motivos do CEGO: ${top.map(([r, n]) => `${n}× ${r.slice(0, 58)}`).join(" | ")}`,
    );

    const blindRatio = totals.blind / entries;
    expect(
      blindRatio,
      `balde CEGO cresceu além do teto congelado — alguma mudança deixou a engine mais silenciosa`,
    ).toBeLessThanOrEqual(BLIND_CEILING);
    // A soma tem de fechar: entrada sem veredito é buraco na própria auditoria.
    expect(totals.mechanized + totals.declared + totals.blind).toBe(entries);
  });

  it("o gerador é determinístico (mesma seed → mesma ficha)", () => {
    // Sem isto, um teste vermelho seria irreproduzível e viraria `skip`.
    const a = makeCorpusCharacter({ seed: 42 });
    const b = makeCorpusCharacter({ seed: 42 });
    expect(a).toEqual(b);
    expect(makeCorpusCharacter({ seed: 43 })).not.toEqual(a);
  });

  it("o corpus varre o que as fixtures nunca tocaram", () => {
    // A suíte inteira rodava sobre um Goblin Rogue 5 sem conjuração e seis
    // bonecos de HP. Se o corpus não trouxer conjurador, nível alto e classes
    // variadas, ele não está medindo nada de novo.
    const classes = new Set(corpus.map((c) => c.className));
    expect(classes.size, "variedade de classes").toBeGreaterThan(5);
    expect(corpus.some((c) => c.spellcasting.length > 0), "algum conjurador").toBe(true);
    expect(corpus.some((c) => c.level >= 15), "algum nível alto").toBe(true);
    expect(corpus.some((c) => c.feats.length >= 10), "alguma ficha carregada").toBe(true);
  });

  it("seed diferente continua verde (o teste não depende DA ficha)", () => {
    // A prova de que a suíte generalizou: trocar a seed não pode quebrar nada.
    for (const c of makeCorpus(98765, 20)) {
      const report = auditCharacter(c);
      expect(report.entries.length).toBeGreaterThan(0);
      expect(report.counts.mechanized + report.counts.declared + report.counts.blind).toBe(
        report.entries.length,
      );
    }
  });

  it("toda entrada CEGA traz o porquê (razão é o produto)", () => {
    // Um veredito sem razão não serve para declarar ao jogador (T5) nem para
    // priorizar. Auditoria que só conta é relatório, não ferramenta.
    for (const c of corpus.slice(0, 10)) {
      for (const e of auditCharacter(c).entries) {
        expect(e.reason.length, `${e.name} sem razão`).toBeGreaterThan(10);
      }
    }
  });

  it("censo do dataset: quanto de cada categoria de ficha tem leitor", () => {
    const census = datasetCoverageCensus();
    const line = Object.entries(census)
      .map(([cat, { total, withReader }]) => `${cat} ${withReader}/${total}`)
      .join(" | ");
    console.log(`[T9] docs de ficha com leitor: ${line}`);
    // feats é a maior categoria e a que mais importa: se ela zerar, algum
    // índice quebrou.
    expect(census.feats!.withReader).toBeGreaterThan(0);
  });
});
