import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildTools,
  TOOL_DEFS,
  TOOL_NAMES,
  validateToolArgs,
} from "./tool-schemas.js";
import { ENCOUNTER_DIFFICULTIES } from "./combat.js";

const here = dirname(fileURLToPath(import.meta.url));
const agentSource = readFileSync(join(here, "agent.ts"), "utf8");

const tools = buildTools();
const toolByName = new Map(tools.map((t) => [t.function.name, t]));

/** Schema gerado de uma tool, já no formato que vai no request. */
function paramsOf(name: string): Record<string, any> {
  const t = toolByName.get(name);
  expect(t, `tool ${name} não existe`).toBeDefined();
  return t!.function.parameters as Record<string, any>;
}

describe("registro de tools (fonte única)", () => {
  it("declara exatamente as tools que executeTool despacha", () => {
    // `case "roll_check":` etc. no switch de executeTool.
    const cases = [...agentSource.matchAll(/^\s{4}case "([a-z_]+)":/gm)].map(
      (m) => m[1]!,
    );
    expect(cases.length).toBeGreaterThan(0);
    expect([...cases].sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("nenhuma descrição promete uma tool que não existe", () => {
    // O bug: `roll_damage` era citada em duas descrições e devolvia
    // "Unknown tool" a quem obedecesse. Snake_case numa descrição só pode ser
    // nome de tool registrada (ou um valor de enum conhecido).
    const allowed = new Set([...TOOL_NAMES, "treat_wounds"]);
    for (const def of TOOL_DEFS) {
      const tokens = [...def.description.matchAll(/\b[a-z]+_[a-z_]+\b/g)].map(
        (m) => m[0],
      );
      for (const t of tokens) {
        expect(allowed.has(t), `${def.name} cita "${t}", que não é tool`).toBe(true);
      }
    }
  });

  it("gera uma declaração por tool, na ordem do registro", () => {
    expect(tools).toHaveLength(TOOL_DEFS.length);
    expect(tools.map((t) => t.function.name)).toEqual(TOOL_DEFS.map((d) => d.name));
    for (const t of tools) {
      expect(t.type).toBe("function");
      expect(t.function.description!.length).toBeGreaterThan(20);
    }
  });
});

describe("JSON Schema derivado do zod", () => {
  it("fecha todo objeto a parâmetro desconhecido", () => {
    for (const name of TOOL_NAMES) {
      const p = paramsOf(name);
      expect(p.type).toBe("object");
      expect(p.additionalProperties, `${name} aceita chave desconhecida`).toBe(false);
    }
  });

  it("não vaza $schema no payload", () => {
    for (const name of TOOL_NAMES) {
      expect(paramsOf(name).$schema).toBeUndefined();
    }
  });

  it("publica os enums que o template renderiza no prompt", () => {
    expect(paramsOf("rest").properties.kind.enum).toEqual([
      "overnight",
      "treat_wounds",
    ]);
    // Fim da duplicação: o enum vem de combat.ts, não de um literal à mão.
    expect(paramsOf("start_combat").properties.difficulty.enum).toEqual([
      ...ENCOUNTER_DIFFICULTIES,
    ]);
  });

  it("mantém os required que a engine depende", () => {
    expect(paramsOf("roll_check").required).toEqual(["skill", "reason"]);
    expect(paramsOf("use_item").required).toEqual(["item", "reason"]);
    expect(paramsOf("cast_spell").required).toEqual(["spell"]);
    expect(paramsOf("rest").required).toEqual(["kind"]);
    expect(paramsOf("start_combat").required).toEqual(["enemies"]);
    expect(paramsOf("end_combat").required).toEqual(["reason"]);
    expect(paramsOf("lookup_rule").required).toEqual(["query"]);
    expect(paramsOf("spend_actions").required).toEqual(["actions", "reason"]);
  });

  it("descreve enemies como objeto aninhado de verdade", () => {
    const items = paramsOf("start_combat").properties.enemies.items;
    expect(items.type).toBe("object");
    expect(items.required).toEqual(["name"]);
    expect(items.additionalProperties).toBe(false);
    expect(Object.keys(items.properties).sort()).toEqual(["count", "level", "name"]);
  });

  it("tools sem argumento não têm propriedade nenhuma", () => {
    for (const name of ["end_turn", "get_character"]) {
      expect(Object.keys(paramsOf(name).properties ?? {})).toEqual([]);
    }
  });
});

describe("aceitação: o que já funcionava continua funcionando", () => {
  // Corpus real da bateria feat-audit — a rede contra apertar demais o contrato
  // (risco registrado na Fase 1 do roadmap).
  const fixture = JSON.parse(
    readFileSync(join(here, "tool-calls.fixture.json"), "utf8"),
  ) as {
    calls: { tool: string; args: Record<string, unknown>; wasError: boolean }[];
  };

  it("o corpus tem massa suficiente para valer como rede", () => {
    expect(fixture.calls.length).toBeGreaterThanOrEqual(100);
    expect(new Set(fixture.calls.map((c) => c.tool)).size).toBeGreaterThanOrEqual(5);
  });

  it("aceita TODA tool call que a engine aceitou na bateria", () => {
    const rejected: string[] = [];
    for (const call of fixture.calls) {
      if (call.wasError) continue;
      const res = validateToolArgs(call.tool, call.args);
      if (!res.ok) {
        rejected.push(`${call.tool} ${JSON.stringify(call.args)} → ${res.message}`);
      }
    }
    expect(rejected).toEqual([]);
  });
});

describe("rejeição de argumento fora do contrato", () => {
  const reject = (tool: string, args: Record<string, unknown>) => {
    const res = validateToolArgs(tool, args);
    expect(res.ok, `${tool} ${JSON.stringify(args)} deveria ser rejeitado`).toBe(false);
    return res.ok ? "" : res.message;
  };

  it("roll_check sem dc e sem target (6 de 16 erros da bateria)", () => {
    const msg = reject("roll_check", { skill: "medicine", reason: "Battle Medicine" });
    expect(msg).toMatch(/real DC/);
    expect(msg).toMatch(/target/);
  });

  it("parâmetro desconhecido, mesmo junto de um efeito válido", () => {
    // O buraco do guard antigo: `KNOWN_PARAMS` só reclamava quando NÃO havia
    // efeito reconhecido, então `updateType` colado num hpDelta válido era
    // descartado em silêncio.
    expect(reject("update_state", { updateType: "off-guard" })).toMatch(/updateType/);
    expect(reject("update_state", { updateType: "off-guard", hpDelta: -4 })).toMatch(
      /updateType/,
    );
  });

  it("tipo errado não é coagido em silêncio", () => {
    reject("roll_check", { skill: "stealth", reason: "sneak", dc: "15" });
    reject("update_state", { hpDelta: "-4" });
    reject("spend_actions", { actions: "2", reason: "Raise a Shield" });
    reject("update_state", { addConditions: "off-guard" });
  });

  it("custo de ação absurdo é rejeitado em vez de clampado", () => {
    reject("roll_check", { skill: "dagger", target: "Bandit", reason: "Strike", actions: 7 });
    reject("spend_actions", { actions: -1, reason: "nada" });
  });

  it("dc abaixo do piso da engine", () => {
    // Espelha isValidDc: DC < 5 fabricava crits automáticos.
    reject("roll_check", { skill: "stealth", reason: "sneak", dc: 0 });
    reject("roll_check", { skill: "stealth", reason: "sneak", dc: 3 });
  });

  it("string vazia não passa por preenchida", () => {
    reject("use_item", { item: "", reason: "bebe a poção" });
    reject("cast_spell", { spell: "" });
    reject("lookup_rule", { query: "" });
  });

  it("enum fora do vocabulário", () => {
    reject("rest", { kind: "nap" });
    reject("start_combat", { enemies: [{ name: "Bandit" }], difficulty: "impossible" });
  });

  it("enemies malformado", () => {
    reject("start_combat", { enemies: [] });
    reject("start_combat", { enemies: [{ level: 2 }] });
    reject("start_combat", { enemies: [{ name: "Bandit", count: 99 }] });
    reject("start_combat", { enemies: "a bandit" });
  });

  it("argumento em tool que não aceita nenhum", () => {
    reject("end_turn", { reason: "acabou" });
    reject("get_character", { verbose: true });
  });

  it("tool desconhecida lista as válidas", () => {
    const msg = reject("roll_damage", { formula: "1d6" });
    expect(msg).toMatch(/Unknown tool: roll_damage/);
    expect(msg).toMatch(/roll_check/);
  });

  it("rejeição sempre diz que nada foi aplicado e como corrigir", () => {
    const msg = reject("update_state", { updateType: "off-guard" });
    expect(msg).toMatch(/NOTHING was applied/);
    expect(msg).toMatch(/Valid parameters for update_state/);
  });
});

describe("aceitação de valores legítimos", () => {
  const accept = (tool: string, args: Record<string, unknown>) => {
    const res = validateToolArgs(tool, args);
    expect(res.ok ? "" : res.message).toBe("");
  };

  it("ataque passa target e omite dc", () => {
    accept("roll_check", { skill: "dagger", target: "Bandit", reason: "Strike" });
  });

  it("check comum passa dc e omite target", () => {
    accept("roll_check", { skill: "stealth", dc: 20, reason: "sneak past" });
  });

  it("save reativo custa 0 ações", () => {
    accept("roll_check", { skill: "reflex", dc: 18, reason: "dodge", actions: 0 });
  });

  it("condições com valor e dano persistente", () => {
    accept("update_state", { addConditions: ["frightened 2"], target: "Bandit" });
    accept("update_state", { addConditions: ["persistent fire damage 1d4"] });
    accept("update_state", { removeConditions: ["off-guard"], target: "Bandit" });
  });

  it("start_combat com criatura oficial e dificuldade", () => {
    accept("start_combat", {
      enemies: [{ name: "Goblin War Chanter", level: 1, count: 2 }],
      difficulty: "moderate",
    });
    accept("start_combat", { enemies: [{ name: "Bandit" }] });
  });

  it("tools sem argumento aceitam objeto vazio", () => {
    accept("end_turn", {});
    accept("get_character", {});
  });

  it("rest nos dois modos", () => {
    accept("rest", { kind: "overnight", reason: "acampa" });
    accept("rest", { kind: "treat_wounds" });
  });
});
