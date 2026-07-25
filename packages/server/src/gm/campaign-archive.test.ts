import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveDestination } from "./campaign-archive.js";

const here = dirname(fileURLToPath(import.meta.url));
const at = (iso: string) => new Date(iso);

describe("archiveDestination", () => {
  it("usa o stamp de minuto quando o destino está livre", () => {
    const dest = archiveDestination("/x/brain", at("2026-07-16T01:19:03Z"), () => false);
    expect(dest).toBe("/x/brain-archive-20260716-0119");
  });

  it("desvia para um sufixo quando o nome já existe", () => {
    // O bug de 2026-07-24: dois imports no mesmo minuto, `renameSync` estourando
    // ENOTEMPTY e o import devolvendo 400 (matou 74 dos 75 cenários da bateria).
    const taken = new Set(["/x/brain-archive-20260716-0119"]);
    const dest = archiveDestination("/x/brain", at("2026-07-16T01:19:41Z"), (p) =>
      taken.has(p),
    );
    expect(dest).toBe("/x/brain-archive-20260716-0119-2");
  });

  it("continua desviando com vários imports no mesmo minuto", () => {
    const taken = new Set<string>();
    const dests: string[] = [];
    for (let i = 0; i < 5; i++) {
      const d = archiveDestination("/x/brain", at("2026-07-16T01:19:00Z"), (p) =>
        taken.has(p),
      );
      taken.add(d);
      dests.push(d);
    }
    // Todos distintos: é o que garante que nenhum rename encontra destino ocupado.
    expect(new Set(dests).size).toBe(5);
    expect(dests).toEqual([
      "/x/brain-archive-20260716-0119",
      "/x/brain-archive-20260716-0119-2",
      "/x/brain-archive-20260716-0119-3",
      "/x/brain-archive-20260716-0119-4",
      "/x/brain-archive-20260716-0119-5",
    ]);
  });

  it("nunca devolve o próprio diretório (arquivar não pode apagar)", () => {
    const dest = archiveDestination("/x/brain", at("2026-07-16T01:19:00Z"), () => false);
    expect(dest).not.toBe("/x/brain");
    expect(dest.startsWith("/x/brain-archive-")).toBe(true);
  });
});

describe("harness da bateria não toca o brain real", () => {
  const harness = readFileSync(
    join(here, "../../scripts/feat-audit/run-feat-tests.ts"),
    "utf8",
  );

  it("passa BRAIN_PATH para o servidor-filho", () => {
    // Sem isso o filho herda o default e a bateria arquiva a campanha do
    // jogador a cada cenário (aconteceu em 2026-07-24).
    expect(harness).toMatch(/BRAIN_PATH:/);
    expect(harness).toMatch(/BRAIN_SANDBOX/);
  });

  it("o BRAIN_PATH da bateria fica dentro do sandbox dela", () => {
    const spawnEnv = /env:\s*\{[\s\S]*?\},/.exec(harness)?.[0] ?? "";
    expect(spawnEnv).toMatch(/BRAIN_PATH:\s*join\(BRAIN_SANDBOX/);
  });

  it("o sandbox é limpo antes e depois da rodada", () => {
    const rms = harness.match(/rmSync\(BRAIN_SANDBOX/g) ?? [];
    expect(rms.length).toBeGreaterThanOrEqual(2);
  });
});
