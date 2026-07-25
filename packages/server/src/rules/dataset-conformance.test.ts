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
 * `actions.json` e como feat de 1 AÇÃO em `feats.json`; o índice é primeiro-ganha
 * por ordem alfabética de arquivo, então a engine servia a reação e cobrava zero
 * pelo feat. Só apareceu porque caiu na amostra da bateria.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { costProfileOf, type RuleRecord } from "./dataset.js";
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
