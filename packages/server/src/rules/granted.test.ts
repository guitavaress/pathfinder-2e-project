/**
 * `GrantItem`: o que a ficha ganha sem estar escrito nela.
 *
 * Censo que motivou (2026-08-16, 60 fichas geradas): `GrantItem` é a key sem
 * leitor que mais aparece em ficha REAL — 131 das 343 entradas cegas com rule
 * element (38,2%), e única key de 59 delas. `AdjustModifier` (10) e `DamageDice`
 * (7), que pareciam grandes contando rule elements no dataset inteiro, são
 * quase irrelevantes numa ficha: a métrica errada apontava para o alvo errado.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Character } from "@pf2e/shared";
import { grantedDocsFor, grantedNamesFor } from "./granted.js";
import { makeCorpus } from "./corpus.js";
import { auditCharacter } from "./coverage.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));

function mk(overrides: Partial<Character>): Character {
  return {
    name: "T",
    level: 5,
    feats: [],
    classFeatures: [],
    weapons: [],
    spellcasting: [],
    equipment: [],
    skills: {},
    lores: [],
    ...overrides,
  } as unknown as Character;
}

describe.skipIf(!hasGenerated)("grantedDocsFor (requer generated/)", () => {
  it("resolve a concessão direta de um feat", () => {
    // `Innate Venom` concede a ação `Envenom` — que a ficha não lista e que,
    // até 2026-08-16, não existia para a engine: sem custo, sem rule element,
    // sem paleta, sem desambiguação.
    const granted = grantedDocsFor(mk({ feats: ["Innate Venom"] }));
    expect(granted.map((g) => g.name)).toContain("Envenom");
    const envenom = granted.find((g) => g.name === "Envenom")!;
    expect(envenom.category).toBe("actions");
    expect(envenom.via).toBe("Innate Venom");
    expect(envenom.depth).toBe(1);
  });

  it("NÃO devolve o que a ficha já nomeia (senão contaria duas vezes)", () => {
    const granted = grantedNamesFor(mk({ feats: ["Innate Venom", "Envenom"] }));
    expect(granted).not.toContain("Envenom");
  });

  it("ficha sem feats não concede nada", () => {
    expect(grantedDocsFor(mk({}))).toEqual([]);
  });

  it("é determinístico e sem duplicatas", () => {
    const c = mk({ feats: ["Innate Venom", "Aquatic Adaptation"] });
    const a = grantedNamesFor(c);
    const b = grantedNamesFor(c);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });

  it("sobrevive a ciclo e a cadeia longa sem travar", () => {
    // O dado TEM ciclos (variantes que se concedem mutuamente). Sem guarda de
    // visitados + teto de profundidade, isto é laço infinito no meio do turno.
    // O teste vale pelo tempo: se voltar, a guarda existe.
    const c = mk({ feats: ["Clan Dagger", "Innate Venom", "Aquatic Adaptation"] });
    const started = Date.now();
    const granted = grantedNamesFor(c);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(Array.isArray(granted)).toBe(true);
  });

  it("nome que o dataset não conhece não concede nada (nem explode)", () => {
    expect(grantedDocsFor(mk({ feats: ["Feat Que Eu Inventei"] }))).toEqual([]);
  });

  it("nenhuma ficha do corpus faz a resolução explodir", () => {
    for (const c of makeCorpus(1234, 30)) {
      expect(() => grantedNamesFor(c), `ficha ${c.name}`).not.toThrow();
    }
  });

  it("o concedido ENTRA na auditoria de cobertura", () => {
    // O ganho real: o doc concedido traz a própria mecânica. Antes, o feat que
    // concede aparecia como cego e o concedido não aparecia de forma alguma —
    // a ficha era medida menor do que é.
    const c = mk({ feats: ["Innate Venom"] });
    const nomes = auditCharacter(c).entries.map((e) => e.name);
    expect(nomes).toContain("Innate Venom");
    expect(nomes).toContain("Envenom");
  });

  it("a AÇÃO concedida é achada no dataset, não reportada como inexistente", () => {
    // Regressão do bug encontrado ao ligar isto: `actions` não está entre as
    // categorias de ficha, então a auditoria procurava a ação concedida só em
    // `feats`/`classes`/… e a declarava "nome não casa nenhum doc" — falso, e
    // inflou o balde cego em 53 entradas.
    const entry = auditCharacter(mk({ feats: ["Innate Venom"] })).entries.find(
      (e) => e.name === "Envenom",
    )!;
    expect(entry.reason).not.toContain("não casa nenhum doc");
  });
});
