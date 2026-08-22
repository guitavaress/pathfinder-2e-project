/**
 * Ações de perícia com consequência — e a amarra que torna a tabela aceitável.
 *
 * `skill-actions.ts` é uma EXCEÇÃO DECLARADA à doutrina 3: as 16 ações de
 * perícia mais usadas têm ZERO rule elements no dataset (censo de 2026-08-16),
 * então a consequência mora em código. O que impede isso de virar folclore é o
 * teste de conformidade abaixo: cada entrada só passa se a condição que ela
 * aplica APARECER no texto oficial da ação, no grau declarado. Tabela que
 * divergir da fonte fica vermelha.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { categoryRecords } from "./dataset.js";
import { officialConditions } from "./dataset.js";
import { SKILL_ACTIONS, outcomeOf, skillActionFor } from "./skill-actions.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));

/**
 * O trecho do texto oficial que descreve UM grau, até o próximo.
 *
 * O `indexOf("Success")` ingênuo casa dentro de "Critical Success" e lê o
 * trecho errado — foi assim que a primeira versão deste helper acusou
 * falsamente que Grapple não aplica `grabbed`. "Success" e "Failure" precisam
 * de lookbehind negando "Critical ".
 */
function degreeText(full: string, degree: string): string {
  const flat = full.replace(/\s+/g, " ");
  const pattern = /^Critical /.test(degree) ? degree : `(?<!Critical )${degree}`;
  const start = new RegExp(pattern).exec(flat);
  if (!start) return "";
  const from = start.index + start[0].length;
  const rest = flat.slice(from);
  const next = /(Critical Success|(?<!Critical )Success|Critical Failure|(?<!Critical )Failure)/.exec(
    rest,
  );
  return next ? rest.slice(0, next.index) : rest;
}

const LABEL: Record<string, string> = {
  criticalSuccess: "Critical Success",
  success: "Success",
  failure: "Failure",
  criticalFailure: "Critical Failure",
};

describe.skipIf(!hasGenerated)("conformidade da tabela com o dado (requer generated/)", () => {
  const actions = categoryRecords("actions");

  it("toda ação da tabela existe no dataset com o nome exato", () => {
    for (const spec of SKILL_ACTIONS) {
      const rec = actions.find((r) => r.name === spec.name);
      expect(rec, `${spec.name} não existe em actions.json`).toBeDefined();
    }
  });

  it("toda condição aplicada é uma condição OFICIAL do PF2e", () => {
    const oficiais = officialConditions();
    for (const spec of SKILL_ACTIONS) {
      for (const [degree, outcome] of Object.entries(spec.outcomes)) {
        const base = outcome.condition.replace(/\s+\d+$/, "");
        expect(oficiais.has(base), `${spec.name}/${degree}: "${base}" não é condição oficial`).toBe(
          true,
        );
      }
    }
  });

  it("a condição da tabela APARECE no texto oficial daquele grau", () => {
    // A amarra que importa: se alguém escrever que Trip aplica "clumsy", ou
    // mover a condição para o grau errado, isto fica vermelho.
    for (const spec of SKILL_ACTIONS) {
      const rec = actions.find((r) => r.name === spec.name)!;
      for (const [degree, outcome] of Object.entries(spec.outcomes)) {
        // O dado usa as duas grafias — "Off Guard" no crítico do Feint e
        // "off-guard" no sucesso. Normalizar hífen/espaço compara o CONCEITO
        // sem afrouxar a checagem: "prone" continua tendo de aparecer.
        const norm = (s: string) => s.toLowerCase().replace(/[-\s]+/g, " ");
        // RAW do PF2e: grau NÃO listado usa o do sucesso ("Create a Diversion"
        // e "Hide" só listam Success). Não é afrouxamento do teste — é a regra
        // de graus do jogo, e sem ela a tabela seria obrigada a mentir que o
        // crítico não faz nada.
        const proprio = degreeText(rec.text ?? "", LABEL[degree]!);
        const trecho = norm(
          proprio || (degree === "criticalSuccess" ? degreeText(rec.text ?? "", "Success") : ""),
        );
        const base = norm(outcome.condition.replace(/\s+\d+$/, ""));
        expect(
          trecho.includes(base),
          `${spec.name}/${degree}: a tabela aplica "${base}", que não aparece no texto oficial desse grau`,
        ).toBe(true);
      }
    }
  });

  it("o custo de ação vem do DADO, não da tabela", () => {
    // A tabela não declara custo de propósito: `costProfileOf` já resolve isso
    // do dataset, e duplicar seria criar uma segunda fonte de verdade.
    for (const spec of SKILL_ACTIONS) {
      const rec = actions.find((r) => r.name === spec.name)!;
      expect(rec.actionCost, `${spec.name} sem custo no dado`).toBeGreaterThan(0);
    }
  });
});

describe("casamento da ação (não depende do dataset)", () => {
  it("exige NOME e PERÍCIA — palavra solta na prosa não aplica condição", () => {
    // Este módulo MUDA O ESTADO, então casar por uma palavra qualquer seria
    // perigoso: "eu tento intimidar o clima" não pode derrubar frightened.
    expect(skillActionFor("eu uso Demoralize no goblin", "intimidation")?.name).toBe("Demoralize");
    expect(skillActionFor("eu uso Demoralize no goblin", "athletics")).toBeNull();
    expect(skillActionFor("eu rolo intimidação para lembrar da história", "intimidation")).toBeNull();
  });

  it("Trip é Athletics, não Acrobatics", () => {
    expect(skillActionFor("I Trip the goblin", "athletics")?.name).toBe("Trip");
    expect(skillActionFor("I Trip the goblin", "acrobatics")).toBeNull();
  });

  it("grau sem consequência devolve null (é RAW, não omissão)", () => {
    const trip = SKILL_ACTIONS.find((s) => s.name === "Trip")!;
    expect(outcomeOf(trip, "success")?.condition).toBe("prone");
    // Trip que simplesmente falha não derruba ninguém.
    expect(outcomeOf(trip, "failure")).toBeNull();
  });

  it("crítico que sai pela culatra cai em QUEM AGIU", () => {
    const trip = SKILL_ACTIONS.find((s) => s.name === "Trip")!;
    expect(outcomeOf(trip, "criticalFailure")).toEqual({ condition: "prone", on: "self" });
  });

  it("Demoralize escala com o grau (frightened 2 no crítico)", () => {
    const dem = SKILL_ACTIONS.find((s) => s.name === "Demoralize")!;
    expect(outcomeOf(dem, "criticalSuccess")?.condition).toBe("frightened 2");
    expect(outcomeOf(dem, "success")?.condition).toBe("frightened 1");
  });
});
