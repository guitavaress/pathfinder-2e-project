/**
 * Varredura de conformidade do dataset INTEIRO.
 *
 * Não testa regra de PF2e — testa que os leitores da engine são TOTAIS sobre o
 * dado que existe. A pergunta que este arquivo responde é "que outros problemas
 * existem que ainda não vimos": em vez de esperar um feat específico falhar na
 * bateria (que custa GPU e olha 75 casos), percorre os 8.306 registros de
 * feats/ações, as 44 condições, as magias e os statblocks do bestiary em
 * segundos.
 *
 * A classe de bug que motivou isto: "Shake it Off" existe como REAÇÃO em
 * `actions.json` e como feat de 1 AÇÃO em `feats.json`; o índice por nome é
 * primeiro-ganha, então a engine servia a reação e cobrava zero pelo feat. Só
 * apareceu porque caiu na amostra da bateria. Hoje a precedência é declarada em
 * código (`NAME_INDEX_ORDER`) e quem precisa da categoria certa usa
 * `categoryRecords` — mas o homônimo continua existindo, e a decisão sobre
 * expô-lo em `lookupLocalRule` segue em aberto.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { costProfileOf, type RuleRecord } from "./dataset.js";
import { classifyDefense, normalizeDamageType } from "./damage.js";
import {
  coversStatement,
  DECLARED_UNCOVERED,
  PARTIAL_COVERAGE,
  prefixOf,
  rollOptionsFor,
} from "./roll-options.js";
import { evaluate } from "./predicate.js";
import { ENGINE_COMPOSED_SELECTORS } from "./actor-modifiers.js";

/**
 * Um prefixo de roll option com este número de ocorrências ou mais é DOMÍNIO
 * DE PESO: tem de estar coberto ou declarado. Abaixo disso é a cauda de
 * namespaces de um feat só (`chimera-flail:head:lion`), que não se enumera.
 */
const HEAVY_DOMAIN = 50;

/**
 * Contexto MÁXIMO — jogador com ficha atacando um alvo com uma arma. É o teto
 * do que a engine sabe hoje; medir contra ele diz quanto do dado é alcançável
 * sem modelar nada de novo.
 */
function maximalRollOptions(): ReturnType<typeof rollOptionsFor> {
  return rollOptionsFor({
    self: {
      kind: "player",
      level: 5,
      traits: ["human"],
      conditions: ["off-guard"],
      className: "Fighter",
      ancestry: "Human",
      heritage: "Versatile Heritage",
      feats: [],
      classFeatures: [],
      skills: {},
      // A engine passou a modelar efeitos ativos (Fase 2.6): o contexto máximo
      // SABE quais são. Lista vazia é conhecimento — "não está enfurecido" —,
      // diferente de omitir o campo, que seria "não sei".
      effects: [],
    },
    target: { kind: "enemy", level: 3, traits: ["undead"], conditions: ["frightened 1"] },
    action: "Strike",
    item: {
      name: "Longsword +1 (striking)",
      base: "Longsword",
      traits: ["versatile-p"],
      type: "weapon",
      category: "martial",
      melee: true,
      ranged: false,
      damageType: "slashing",
      rank: 1,
      magical: true,
      proficiencyRank: 2,
    },
    // Fase 2.6 / T6.4: armadura vestida e a estatística da rolagem passaram a
    // ser vocabulário da engine.
    armor: { worn: true, category: "light" },
    check: { statistic: "athletics", rank: 2 },
  });
}
import { isOfficialCondition, parseDie, rollFormula } from "../gm/agent.js";
import { enemyCombatant } from "../gm/combat.js";

const here = dirname(fileURLToPath(import.meta.url));
const generatedDir = join(here, "../../data/pf2e/generated");
const hasGenerated = existsSync(generatedDir);

/** Lê uma categoria crua do disco (o índice da engine filtra e dedupe; aqui não). */
function raw(file: string): RuleRecord[] {
  const path = join(generatedDir, file);
  if (!existsSync(path)) return [];
  const arr = JSON.parse(readFileSync(path, "utf8")) as RuleRecord[];
  // `manifest.json`/`uuid-index.json` são objetos, não listas de registro.
  if (!Array.isArray(arr)) return [];
  return arr.filter((r) => r && typeof r.name === "string" && r.category && r.text);
}

/** Mesma normalização de nome que o índice do dataset usa. */
function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .trim();
}

describe.skipIf(!hasGenerated)("conformidade do dataset (requer generated/)", () => {
  const feats = raw("feats.json");
  const actions = raw("actions.json");
  const usable = [...feats, ...actions];

  it("o dataset tem a massa esperada (canário de import quebrado)", () => {
    expect(feats.length).toBeGreaterThan(6000);
    expect(actions.length).toBeGreaterThan(1000);
  });

  it("todo feat/ação tem actionType num dos 4 valores conhecidos", () => {
    // Valor inesperado cai no `else` de costProfileOf e vira `passive` — ou seja,
    // CUSTO ZERO em silêncio. É a falha que nunca aparece até alguém usar o feat.
    const known = new Set(["action", "reaction", "free", "passive"]);
    const bad = usable
      .filter((r) => !known.has(String(r.actionType)))
      .map((r) => `${r.name} (${r.category}): actionType=${String(r.actionType)}`);
    expect(bad).toEqual([]);
  });

  it("actionType 'action' sempre traz um custo utilizável", () => {
    const bad = usable
      .filter((r) => r.actionType === "action")
      .filter((r) => {
        const n = r.actionCost;
        return n !== null && n !== undefined && !(Number.isInteger(n) && n >= 1 && n <= 3);
      })
      .map((r) => `${r.name}: actionCost=${String(r.actionCost)}`);
    expect(bad).toEqual([]);
  });

  it("costProfileOf resolve TODO feat/ação nomeado", () => {
    const unresolved: string[] = [];
    for (const r of usable) {
      const p = costProfileOf(r.name, r.category === "feats" ? "feats" : "actions");
      if (!p) unresolved.push(`${r.name} (${r.category})`);
      else if (p.kind === "action" && p.cost < 1) unresolved.push(`${r.name}: custo ${p.cost}`);
    }
    expect(unresolved).toEqual([]);
  });

  /** Nomes que existem em mais de um registro com custo divergente. */
  function divergentGroups(): RuleRecord[][] {
    const byName = new Map<string, RuleRecord[]>();
    for (const r of usable) {
      const k = norm(r.name);
      byName.set(k, [...(byName.get(k) ?? []), r]);
    }
    const out: RuleRecord[][] = [];
    for (const [, list] of byName) {
      if (list.length < 2) continue;
      const shape = (r: RuleRecord) => `${r.actionType}/${r.actionCost ?? "-"}`;
      if (new Set(list.map(shape)).size > 1) out.push(list);
    }
    return out;
  }

  it("colisão de nome nunca faz um custo real virar passivo", () => {
    // O padrão dominante (34 dos 44 grupos): o registro de `feats` é `passive`
    // porque o feat CONCEDE a habilidade, e a mecânica real está no `actions`
    // homônimo. Se a preferência pela ficha vencesse cegamente, Hunt Prey e
    // Change Shape custariam ZERO e 7 reações nunca debitariam a reação.
    const swallowed: string[] = [];
    for (const group of divergentGroups()) {
      const hasConcrete = group.some((r) => r.actionType && r.actionType !== "passive");
      if (!hasConcrete) continue;
      for (const prefer of ["feats", "actions"] as const) {
        const p = costProfileOf(group[0]!.name, prefer);
        if (!p || p.kind === "passive") {
          swallowed.push(`${group[0]!.name} (prefer=${prefer}) -> ${p?.kind ?? "null"}`);
        }
      }
    }
    expect(swallowed).toEqual([]);
  });

  it("a ficha ainda desempata quando os DOIS lados têm custo real", () => {
    // Caso Shake it Off: feats=action/1 vs actions=reaction. Quem tem o feat na
    // ficha usa o feat — não a ação homônima.
    expect(costProfileOf("Shake it Off", "feats")).toMatchObject({ kind: "action", cost: 1 });
    expect(costProfileOf("Shake it Off", "actions")).toMatchObject({ kind: "reaction" });
  });

  it("o volume de colisões divergentes não cresce sem revisão", () => {
    // Canário de import: um `PF2E_GIT_REF` novo que multiplique colisões muda a
    // semântica de custo em silêncio.
    expect(divergentGroups().length).toBeLessThanOrEqual(50);
  });

  it("toda condição oficial passa no guard, inclusive valuada", () => {
    const conditions = raw("conditions.json");
    expect(conditions.length).toBeGreaterThanOrEqual(40);
    const rejected = conditions
      .filter((c) => !isOfficialCondition(c.name))
      .map((c) => c.name);
    expect(rejected).toEqual([]);
    // Formas valuadas usadas pelo jogo real.
    for (const valued of ["frightened 2", "clumsy 1", "drained 3", "slowed 1"]) {
      expect(isOfficialCondition(valued), valued).toBe(true);
    }
    // Os dois formatos que a PRÓPRIA engine grava no tick de fim de rodada.
    expect(isOfficialCondition("persistent fire damage 1d4")).toBe(true);
    expect(isOfficialCondition("persistent bleed damage 2")).toBe(true);
    expect(isOfficialCondition("persistent damage")).toBe(true);
    expect(isOfficialCondition("slowed -15ft")).toBe(false);
  });

  it("toda magia usa um save que a engine resolve e dano parseável", () => {
    const spells = raw("spells.json").filter((r) => r.spell);
    expect(spells.length).toBeGreaterThan(1000);
    const saves = new Set(["fortitude", "reflex", "will"]);
    const badSave: string[] = [];
    const badDamage: string[] = [];
    for (const r of spells) {
      const mech = r.spell as unknown as {
        defense?: { save?: string };
        damage?: { formula?: string }[];
      };
      const save = mech.defense?.save;
      if (save && !saves.has(save)) badSave.push(`${r.name}: save=${save}`);
      for (const d of mech.damage ?? []) {
        const f = d.formula;
        if (typeof f !== "string" || !/\d+\s*d\s*\d+|^\d+$/i.test(f)) {
          badDamage.push(`${r.name}: formula=${String(f)}`);
        }
      }
    }
    expect(badSave).toEqual([]);
    // Defeito de DADO conhecido, upstream: o importador não resolve a expressão
    // de template do Foundry, e `rollFormula("@item.rank")` devolve 0 em
    // silêncio — a magia causaria zero de dano. Raio de alcance: 1 magia.
    // A lista é fechada de propósito: se um import novo trouxer mais, falha.
    expect(badDamage).toEqual(["Purging Toxins: formula=@item.rank"]);
  });

  it("nenhuma criatura do bestiary nasce derrotada (hp <= 0)", () => {
    // `Phantasmal Protagonist` (nível 4) vem com hp 0 no dataset; sem o guard
    // em `enemyCombatant` ela entraria em combate já derrotada.
    const zeroHp = raw("bestiary.json")
      .filter((r) => r.statblock)
      .filter((r) => !((r.statblock as unknown as { hp?: number }).hp! > 0))
      .map((r) => r.name);
    expect(zeroHp).toEqual(["Phantasmal Protagonist"]);
    const c = enemyCombatant("Phantasmal Protagonist", 4, {
      hp: 0,
      ac: 10,
      perception: 0,
      saves: { fortitude: 0, reflex: 0, will: 0 },
      sourceName: "Phantasmal Protagonist",
      traits: [],
    } as unknown as Parameters<typeof enemyCombatant>[2]);
    expect(c.maxHp).toBeGreaterThan(0);
    expect(c.defeated).toBeFalsy();
  });

  it("todo statblock do bestiary vira um combatente sem explodir", () => {
    const bestiary = raw("bestiary.json").filter((r) => r.statblock);
    expect(bestiary.length).toBeGreaterThan(1000);
    const broken: string[] = [];
    for (const r of bestiary) {
      const sb = r.statblock as unknown as Parameters<typeof enemyCombatant>[2];
      try {
        const c = enemyCombatant(r.name, r.level ?? 0, {
          ...(sb as object),
          sourceName: r.name,
          traits: r.traits ?? [],
        } as Parameters<typeof enemyCombatant>[2]);
        if (!Number.isFinite(c.ac) || !Number.isFinite(c.maxHp) || c.maxHp <= 0) {
          broken.push(`${r.name}: ac=${c.ac} hp=${c.maxHp}`);
        }
      } catch (err) {
        broken.push(`${r.name}: ${(err as Error).message}`);
      }
    }
    expect(broken.slice(0, 20)).toEqual([]);
  });

  it("mede a cobertura das roll options sobre os predicados REAIS", () => {
    // T2 não altera comportamento — instala vocabulário. O que este teste
    // guarda é a honestidade dele: todo statement do dataset ou é decidível
    // pelo contexto máximo, ou está DECLARADO como não modelado. Statement que
    // não caia em nenhum dos dois é ponto cego silencioso — e quebra aqui.
    const counts = new Map<string, number>();
    const collect = (p: unknown): void => {
      if (typeof p === "string") {
        counts.set(p, (counts.get(p) ?? 0) + 1);
        return;
      }
      if (Array.isArray(p)) {
        p.forEach(collect);
        return;
      }
      if (p && typeof p === "object") {
        for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
          if (["or", "and", "not", "nor", "nand", "xor"].includes(k)) collect(v);
          else if (["gte", "lte", "gt", "lt", "eq"].includes(k)) {
            if (Array.isArray(v) && typeof v[0] === "string") {
              counts.set(v[0], (counts.get(v[0]) ?? 0) + 1);
            }
          } else collect(v);
        }
      }
    };
    for (const file of readdirSync(generatedDir).filter((f) => f.endsWith(".json"))) {
      if (file === "manifest.json" || file === "uuid-index.json") continue;
      for (const r of raw(file)) {
        for (const re of (r.rules ?? []) as { predicate?: unknown }[]) {
          if (re?.predicate) collect(re.predicate);
        }
      }
    }
    expect(counts.size).toBeGreaterThan(1000);

    const full = maximalRollOptions();

    let decidable = 0;
    let declared = 0;
    const orphans = new Map<string, number>();
    for (const [stmt, n] of counts) {
      if (coversStatement(full, stmt)) decidable += n;
      else if (
        (DECLARED_UNCOVERED as readonly string[]).includes(prefixOf(stmt)) ||
        // Domínio coberto só até certa profundidade: o que passa dela é dívida
        // declarada igual (o badge de efeito, que o registro não guarda).
        prefixOf(stmt) in PARTIAL_COVERAGE
      ) {
        declared += n;
      } else orphans.set(prefixOf(stmt), (orphans.get(prefixOf(stmt)) ?? 0) + n);
    }
    const orphanTotal = [...orphans.values()].reduce((s, v) => s + v, 0);
    const total = decidable + declared + orphanTotal;
    const heavy = [...orphans.entries()]
      .filter(([, n]) => n >= HEAVY_DOMAIN)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}(${v})`);
    console.log(
      `[T2] statements: ${total} | decidíveis ${decidable} (${Math.round((decidable / total) * 100)}%) | declarados ${declared} | cauda não enumerada ${orphanTotal} em ${orphans.size} prefixos`,
    );
    // A cauda de namespaces de um feat só é esperada e não se enumera. O que
    // NÃO se admite é um domínio de peso passando despercebido: ou a engine o
    // cobre, ou ele está declarado. Import novo com domínio grande falha aqui.
    expect(heavy).toEqual([]);
  });

  it("o avaliador de predicados é TOTAL sobre a gramática real do dataset", () => {
    // A pergunta: existe alguma forma sintática nos 7.948 predicados reais que
    // o avaliador não reconheça? Forma não reconhecida nunca vira verdadeiro,
    // mas também não pode passar despercebida — é gramática que falta.
    const full = maximalRollOptions();
    let decided = 0;
    let unknown = 0;
    let total = 0;
    const malformed = new Map<string, number>();
    const undecidedPrefix = new Map<string, number>();
    for (const file of readdirSync(generatedDir).filter((f) => f.endsWith(".json"))) {
      if (file === "manifest.json" || file === "uuid-index.json") continue;
      for (const r of raw(file)) {
        for (const re of (r.rules ?? []) as { predicate?: unknown }[]) {
          if (!re?.predicate) continue;
          total += 1;
          const ev = evaluate(re.predicate, full);
          if (ev.value === "unknown") unknown += 1;
          else decided += 1;
          for (const m of ev.malformed) malformed.set(m, (malformed.get(m) ?? 0) + 1);
          for (const u of ev.undecided) {
            const p = prefixOf(u);
            undecidedPrefix.set(p, (undecidedPrefix.get(p) ?? 0) + 1);
          }
        }
      }
    }
    expect(total).toBeGreaterThan(5000);
    const topUndecided = [...undecidedPrefix.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, v]) => `${k}(${v})`);
    console.log(
      `[T3] predicados: ${total} | decididos ${decided} (${Math.round((decided / total) * 100)}%) | indecidíveis ${unknown} → ${topUndecided.join(" ")}`,
    );
    // Gramática incompleta é bug de código, não dívida de modelagem: zero.
    expect([...malformed.entries()]).toEqual([]);
  });

  it("toda entrada de defesa do bestiary cai num balde CONHECIDO", () => {
    // A pergunta que este teste responde: apareceu algum tipo de defesa que a
    // T1 não classificou? "unknown" seria ignorado em silêncio no combate —
    // exatamente o erro que a Fase 2.5 existe para acabar.
    const unknown = new Map<string, number>();
    for (const r of raw("bestiary.json")) {
      const sb = r.statblock as unknown as {
        immunities?: string[];
        weaknesses?: { type: string }[];
        resistances?: { type: string }[];
      };
      if (!sb) continue;
      const entries = [
        ...(sb.immunities ?? []),
        ...(sb.weaknesses ?? []).map((w) => w.type),
        ...(sb.resistances ?? []).map((w) => w.type),
      ];
      for (const e of entries) {
        if (classifyDefense(e) !== "unknown") continue;
        unknown.set(e, (unknown.get(e) ?? 0) + 1);
      }
    }
    expect([...unknown.keys()].sort()).toEqual([]);
  });

  it("mede o ponto cego declarado das defesas não suportadas", () => {
    // Não é asserção de qualidade — é o número da DÍVIDA, visível a cada run.
    // Sobe quando um import novo traz defesa que exige contexto que não temos.
    const counts: Record<string, number> = {};
    let creaturesAffected = 0;
    for (const r of raw("bestiary.json")) {
      const sb = r.statblock as unknown as {
        immunities?: string[];
        weaknesses?: { type: string }[];
        resistances?: { type: string }[];
      };
      if (!sb) continue;
      const entries = [
        ...(sb.immunities ?? []),
        ...(sb.weaknesses ?? []).map((w) => w.type),
        ...(sb.resistances ?? []).map((w) => w.type),
      ];
      let affected = false;
      for (const e of entries) {
        if (classifyDefense(e) !== "unsupported") continue;
        counts[normalizeDamageType(e)] = (counts[normalizeDamageType(e)] ?? 0) + 1;
        affected = true;
      }
      if (affected) creaturesAffected += 1;
    }
    const top = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([k, v]) => `${k}:${v}`);
    console.log(
      `[T1] defesas não suportadas — ${creaturesAffected} criaturas afetadas; top: ${top.join(" ")}`,
    );
    // Material de arma é a maior fatia e depende de rastrear a arma usada:
    // fica DECLARADO aqui, não implementado (ver plano da Fase 2.5).
    expect(creaturesAffected).toBeGreaterThan(0);
  });

  it("toda fórmula de dano de arma/ataque do bestiary é parseável", () => {
    const bestiary = raw("bestiary.json").filter((r) => r.statblock);
    const bad: string[] = [];
    for (const r of bestiary) {
      const sb = r.statblock as unknown as {
        attacks?: { damage?: { formula?: string }[] }[];
      };
      for (const atk of sb.attacks ?? []) {
        for (const d of atk.damage ?? []) {
          if (typeof d.formula !== "string") {
            bad.push(`${r.name}: formula=${String(d.formula)}`);
            continue;
          }
          // rollFormula nunca deve devolver NaN nem negativo.
          const rolled = rollFormula(d.formula);
          if (!Number.isFinite(rolled) || rolled < 0) {
            bad.push(`${r.name}: "${d.formula}" -> ${rolled}`);
          }
        }
      }
    }
    expect(bad.slice(0, 20)).toEqual([]);
  });

  /**
   * Regressão do conserto do @Localize (T0 da Fase 2.5). O importador APAGAVA
   * `@Localize[...]` sem substituto, e 22% das habilidades de criatura ficavam
   * sem descrição — o texto de Grab, Ferocity, Void Healing e Constrict sumia.
   * Se alguém voltar a descartar o marcador (ou o `static/lang/en.json` sair do
   * sparse-checkout), estes testes caem.
   */
  it("habilidades de glossário do bestiary vêm COM texto", () => {
    const bestiary = raw("bestiary.json").filter((r) => r.statblock);
    const semTexto: string[] = [];
    // Amostra das mais comuns, todas vindas do glossário via @Localize.
    const glossario = new Set([
      "grab",
      "ferocity",
      "void healing",
      "constrict",
      "shield block",
      "reactive strike",
      "swallow whole",
    ]);
    for (const r of bestiary) {
      const sb = r.statblock as unknown as {
        abilitiesList?: { name: string; text?: string }[];
      };
      for (const a of sb.abilitiesList ?? []) {
        if (!glossario.has(a.name.toLowerCase().trim())) continue;
        if (!String(a.text ?? "").trim()) semTexto.push(`${r.name}: ${a.name}`);
      }
    }
    expect(semTexto.slice(0, 20)).toEqual([]);
  });

  it("o vazio residual é só label numérico (a informação está no nome)", () => {
    const bestiary = raw("bestiary.json").filter((r) => r.statblock);
    const inexplicados: string[] = [];
    for (const r of bestiary) {
      const sb = r.statblock as unknown as {
        abilitiesList?: { name: string; text?: string }[];
      };
      for (const a of sb.abilitiesList ?? []) {
        if (String(a.text ?? "").trim()) continue;
        // "+1 Status to All Saves vs. Magic" não tem texto em lugar nenhum —
        // é rótulo de rule element, e o nome JÁ carrega a mecânica.
        if (/^[+-]\s*\d/.test(a.name.trim())) continue;
        inexplicados.push(`${r.name}: ${a.name}`);
      }
    }
    // Teto folgado sobre os 28 medidos em 2026-07-26: pega regressão grossa
    // sem quebrar a cada bump de ref do dataset.
    expect(inexplicados.length).toBeLessThan(120);
  });

  it("o pack de glossário em actions.json não guarda texto sintético", () => {
    const glossario = raw("actions.json").filter(
      (r) => (r as unknown as { pack?: string }).pack === "bestiary-ability-glossary-srd",
    );
    expect(glossario.length).toBeGreaterThan(40);
    // "Level ? common action." era o fallback que entrava quando o @Localize
    // apagava a descrição inteira. Sobra só o rótulo numérico, que não tem
    // texto em lugar nenhum — a mecânica dele É o nome.
    const sinteticos = glossario.filter(
      (r) => /^Level \? \w+ action\.$/.test(r.text) && !/^[+-]\s*\d/.test(r.name.trim()),
    );
    expect(sinteticos.map((r) => r.name).slice(0, 20)).toEqual([]);
  });
});

describe("helpers de dado são totais (não dependem do dataset)", () => {
  it("parseDie aceita as faces reais e cai em 6 no lixo", () => {
    for (const [die, faces] of [
      ["d4", 4],
      ["d6", 6],
      ["d8", 8],
      ["d10", 10],
      ["d12", 12],
      ["D20", 20],
    ] as const) {
      expect(parseDie(die), die).toBe(faces);
    }
    expect(parseDie("")).toBe(6);
    expect(parseDie("sem dado")).toBe(6);
  });

  it("rollFormula nunca devolve NaN nem negativo", () => {
    for (const f of ["2d6+3", "1d4", "3d8 - 2", "1d6+1d4", "", "sem dado", "0d0"]) {
      const v = rollFormula(f);
      expect(Number.isFinite(v), f).toBe(true);
      expect(v, f).toBeGreaterThanOrEqual(0);
    }
  });

  it("rollFormula respeita os limites de um 2d6+3", () => {
    for (let i = 0; i < 200; i++) {
      const v = rollFormula("2d6+3");
      expect(v).toBeGreaterThanOrEqual(5);
      expect(v).toBeLessThanOrEqual(15);
    }
  });
});

describe("sentinela do dataset", () => {
  it("data/pf2e/generated/ existe — sem ele ~60 testes somem em silêncio", () => {
    // Vários describes usam skipIf(!hasGenerated): num clone fresco eles apenas
    // desaparecem e a contagem de testes cai sem ninguém notar. Este falha alto.
    expect(
      hasGenerated,
      "dataset ausente — rode `npm run data:pf2e` (sem ele a cobertura de regras não roda)",
    ).toBe(true);
    const files = readdirSync(generatedDir).filter((f) => f.endsWith(".json"));
    // Import TOTAL (Fase 1.5): todas as categorias do core + manifest + uuids.
    // `misc.json` morreu — era a vala comum que ninguém lia.
    expect(files.sort()).toEqual([
      "actions.json",
      "ancestries.json",
      "armies.json",
      "backgrounds.json",
      "bestiary.json",
      "campaign.json",
      "classes.json",
      "conditions.json",
      "deities.json",
      "effects.json",
      "equipment.json",
      "familiars.json",
      "feats.json",
      "hazards.json",
      "heritages.json",
      "kits.json",
      "macros.json",
      "manifest.json",
      "pregens.json",
      "spells.json",
      "uuid-index.json",
      "vehicles.json",
    ]);
  });
});

describe.skipIf(!hasGenerated)("import total (Fase 1.5): zero perda e grafo", () => {
  const manifest = hasGenerated
    ? (JSON.parse(readFileSync(join(generatedDir, "manifest.json"), "utf8")) as {
        ref: string;
        sourceDocs: number;
        written: number;
        withRules: number;
        byType: Record<string, number>;
        categories: Record<string, number>;
      })
    : null;

  it("manifest prova zero perda no ref 7.8.0", () => {
    expect(manifest!.ref).toBe("7.8.0");
    // Censo 2026-07-26: 27.940 docs com type+name nos packs. O vão até
    // sourceDocs são documentos NÃO-Item (journals/rolltables, sem `type`).
    expect(manifest!.written).toBe(27940);
    expect(manifest!.sourceDocs - manifest!.written).toBeLessThanOrEqual(200);
    // Os tipos que o importador antigo DESCARTAVA inteiros:
    expect(manifest!.byType.hazard).toBe(1106);
    expect(manifest!.byType.character).toBe(140);
    expect(manifest!.byType.ammo).toBe(203);
    expect(manifest!.byType.vehicle).toBe(92);
    // E os volumes-âncora:
    expect(manifest!.byType.feat).toBe(7039);
    expect(manifest!.byType.npc).toBe(6447);
    expect(manifest!.byType.effect).toBe(2815);
    // Rule elements preservados (27% do dataset tem):
    expect(manifest!.withRules).toBeGreaterThanOrEqual(7600);
  });

  it("misc.json morreu e toda categoria do manifest existe no disco", () => {
    const files = new Set(readdirSync(generatedDir));
    expect(files.has("misc.json")).toBe(false);
    for (const cat of Object.keys(manifest!.categories)) {
      expect(files.has(`${cat}.json`), `${cat}.json ausente`).toBe(true);
    }
  });

  it("todo selfEffect de feat resolve para um effect existente", () => {
    const uuidIndex = JSON.parse(
      readFileSync(join(generatedDir, "uuid-index.json"), "utf8"),
    ) as Record<string, { name: string; category: string }>;
    const broken: string[] = [];
    for (const f of raw("feats.json")) {
      const se = (f as { selfEffect?: string }).selfEffect;
      if (!se) continue;
      const target = uuidIndex[se];
      if (!target || target.category !== "effects") {
        broken.push(`${f.name} -> ${se} (${target?.category ?? "inexistente"})`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("rule elements chegam VERBATIM (spot-checks do censo)", () => {
    const featByName = new Map(raw("feats.json").map((r) => [r.name, r]));
    const condByName = new Map(raw("conditions.json").map((r) => [r.name, r]));
    // Off-Guard: o -2 de CA que a engine hard-coda em effectiveAC.
    const og = condByName.get("Off-Guard") as { rules?: Record<string, unknown>[] };
    expect(og?.rules).toEqual([
      { key: "FlatModifier", selector: "ac", slug: "off-guard", type: "circumstance", value: -2 },
    ]);
    // Frightened: penalidade de status em TUDO, dirigida pelo valor (badge).
    const fr = condByName.get("Frightened") as { rules?: Record<string, unknown>[] };
    expect(fr?.rules?.[0]).toMatchObject({
      key: "FlatModifier",
      selector: "all",
      type: "status",
      value: "-@item.badge.value",
    });
    // Nimble Dodge: toggle + FlatModifier de circunstância na CA.
    const nd = featByName.get("Nimble Dodge") as { rules?: Record<string, unknown>[] };
    expect(nd?.rules?.map((r) => r.key)).toEqual(["RollOption", "FlatModifier"]);
  });

  it("taxonomia NATIVA de feat importada (a que o classify recriava na mão)", () => {
    const cats: Record<string, number> = {};
    for (const f of raw("feats.json")) {
      const c = (f as { featCategory?: string }).featCategory ?? "??";
      cats[c] = (cats[c] ?? 0) + 1;
    }
    expect(cats["??"] ?? 0).toBe(0); // todo feat tem categoria
    expect(cats.class).toBe(3914);
    expect(cats.ancestry).toBe(1554);
    expect(cats.skill).toBe(320);
    expect(cats.pfsboon).toBe(157); // os que o testable() filtrava por REGEX
  });

  it("hazards têm statblock utilizável quando o dado o traz", () => {
    const hazards = raw("hazards.json");
    expect(hazards.length).toBe(1106);
    const hidden = hazards.find((h) => h.name === "Hidden Pit") as {
      statblock?: { ac: number; hp: number };
      hazard?: { stealth: number | null; isComplex: boolean };
    };
    expect(hidden?.statblock).toMatchObject({ ac: 10, hp: 12 });
    expect(hidden?.hazard).toMatchObject({ stealth: 8, isComplex: false });
  });
});

/**
 * Cobertura de RULE ELEMENTS (Fase 2.5 / T5.6).
 *
 * A métrica que a fase existe para mover. Antes da T5 a engine lia UMA key
 * (`FlatModifier`) de UMA categoria (`conditions`); o resto do dado era prosa.
 * Este bloco mede o que efetivamente vira comportamento — e, mais importante, o
 * que fica declarado como dívida, para a próxima fase medir contra um número e
 * não contra uma impressão.
 */
describe.skipIf(!hasGenerated)("cobertura de rule elements (T5)", () => {
  /** As keys que a engine consome hoje. Crescer esta lista é o trabalho. */
  const CONSUMED_KEYS = ["FlatModifier", "Resistance", "Weakness", "Immunity"];
  /** E as categorias de onde ela as lê — key sozinha superestimaria. */
  // `effects` entrou na Fase 2.6: o registro de efeitos ativos abriu a categoria
  // inteira para os mesmos quatro leitores (`actor-modifiers.ts`).
  const SHEET = ["feats", "classes", "heritages", "ancestries", "backgrounds"];
  const READ_CATEGORIES: Record<string, string[]> = {
    FlatModifier: ["conditions", ...SHEET, "effects"],
    Resistance: [...SHEET, "effects"],
    Weakness: [...SHEET, "effects"],
    Immunity: [...SHEET, "effects"],
  };

  it("mede quanto do dado a engine ALCANÇA, por key e categoria", () => {
    // Contar por key sozinha mentiria: `FlatModifier` também vive em
    // equipment/effects/bestiary, que nenhum leitor da engine abre. O número
    // honesto é o par (key, categoria) que tem leitor.
    const byKey = new Map<string, number>();
    let reachable = 0;
    for (const file of readdirSync(generatedDir).filter((f) => f.endsWith(".json"))) {
      const category = file.replace(/\.json$/, "");
      for (const r of raw(file)) {
        for (const re of (r.rules ?? []) as { key?: string }[]) {
          const k = re?.key ?? "(none)";
          byKey.set(k, (byKey.get(k) ?? 0) + 1);
          if (READ_CATEGORIES[k]?.includes(category)) reachable++;
        }
      }
    }
    const total = [...byKey.values()].reduce((s, v) => s + v, 0);
    const topUnconsumed = [...byKey.entries()]
      .filter(([k]) => !CONSUMED_KEYS.includes(k))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([k, v]) => `${k}(${v})`);
    console.log(
      `[T5] rule elements: ${total} em ${byKey.size} keys | keys com leitor ${CONSUMED_KEYS.length}/${byKey.size} | REs ALCANÇÁVEIS ${reachable} (${Math.round((reachable / total) * 100)}%) | maiores sem leitor: ${topUnconsumed.join(" ")}`,
    );
    for (const k of CONSUMED_KEYS) expect(byKey.has(k)).toBe(true);
    // Piso da fase: antes da T5 a engine alcançava os 16 FlatModifier de
    // `conditions.json` e nada mais.
    expect(reachable).toBeGreaterThan(1000);
  });

  it("mede o destino dos FlatModifier das categorias de ficha", () => {
    // Simula cada documento como se estivesse na ficha e classifica cada
    // FlatModifier pelo portão que o barra (ou não), contra UM contexto
    // concreto (o guerreiro de espada longa atacando um morto-vivo).
    //
    // `falso` e `indecidível` NÃO são a mesma coisa e por isso não somam no
    // mesmo balde: falso é a engine funcionando (o feat não se aplica àquela
    // cena); indecidível é dívida — vocabulário que a engine ainda não fala.
    const buckets = { aplicavel: 0, falso: 0, indecidivel: 0, presumido: 0, semValor: 0 };
    const full = maximalRollOptions();
    for (const file of ["feats.json", "classes.json", "heritages.json", "ancestries.json", "backgrounds.json"]) {
      for (const r of raw(file)) {
        for (const re of (r.rules ?? []) as Record<string, unknown>[]) {
          if (re?.key !== "FlatModifier") continue;
          const composed = (Array.isArray(re.selector) ? re.selector : [re.selector]).some(
            (s) => typeof s === "string" && ENGINE_COMPOSED_SELECTORS.has(s),
          );
          if (re.predicate === undefined && !composed) {
            buckets.presumido++;
            continue;
          }
          if (re.predicate !== undefined) {
            const verdict = evaluate(re.predicate, full).value;
            if (verdict === "false") {
              buckets.falso++;
              continue;
            }
            if (verdict === "unknown") {
              buckets.indecidivel++;
              continue;
            }
          }
          if (typeof re.value !== "number") buckets.semValor++;
          else buckets.aplicavel++;
        }
      }
    }
    const total = Object.values(buckets).reduce((s, v) => s + v, 0);
    console.log(
      `[T5] FlatModifier de ficha: ${total} | aplicável nesta cena ${buckets.aplicavel} | não se aplica (predicado falso) ${buckets.falso} | INDECIDÍVEL ${buckets.indecidivel} | presumido na ficha ${buckets.presumido} | valor não resolvido ${buckets.semValor}`,
    );
    expect(total).toBeGreaterThan(700);
    // Nenhum bucket pode engolir tudo em silêncio: se um dia `aplicável` for 0,
    // a leitura quebrou e ninguém notaria pelo veredito da bateria.
    expect(buckets.aplicavel).toBeGreaterThan(0);
  });

  it("mede quantas defesas tipadas da ficha são resolvíveis", () => {
    let resolvidas = 0;
    let declaradas = 0;
    for (const file of ["feats.json", "classes.json", "heritages.json", "ancestries.json", "backgrounds.json"]) {
      for (const r of raw(file)) {
        for (const re of (r.rules ?? []) as Record<string, unknown>[]) {
          const k = re?.key;
          if (k !== "Resistance" && k !== "Weakness" && k !== "Immunity") continue;
          const types = Array.isArray(re.type) ? re.type : [re.type];
          const typeOk = types.every((t) => typeof t === "string" && !t.includes("{"));
          const valueOk = k === "Immunity" || typeof re.value === "number";
          if (typeOk && valueOk) resolvidas++;
          else declaradas++;
        }
      }
    }
    console.log(
      `[T5] defesas de ficha: ${resolvidas + declaradas} | resolvíveis ${resolvidas} | declaradas ${declaradas}`,
    );
    // 44 de 260. O grosso das declaradas depende de ChoiceSet (o tipo é uma
    // escolha do jogador, `{item|flags.pf2e.rulesSelections...}`) ou de
    // expressão de nível — as duas dívidas nomeadas da T5.5.
    expect(resolvidas).toBeGreaterThan(40);
  });
});
