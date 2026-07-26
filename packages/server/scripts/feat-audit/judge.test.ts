/**
 * Testes do JUIZ da bateria (J2).
 *
 * O juiz decide PASS/FAIL de 75 cenários que custam 44 minutos de GPU. Até
 * 2026-07-25 ele não tinha teste nenhum — um erro aqui contamina toda leitura
 * de qualidade do jogo, e foi exatamente o que aconteceu (cegueira em 40
 * cenários + dois falsos positivos documentados no ROADMAP).
 *
 * As strings de narrativa marcadas REGRESSÃO são as REAIS que enganaram o juiz.
 */
import { describe, expect, it } from "vitest";
import {
  assertUsage,
  featNamedInTools,
  judge,
  narratesLandedBlow,
  type Scenario,
  type TurnResult,
} from "./judge.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function scenario(over: Partial<Scenario> = {}): Scenario {
  return {
    name: "Nimble Dodge",
    level: 1,
    actionType: "reaction",
    actionCost: null,
    traits: [],
    side: "combat",
    archetype: "reacao-defensiva",
    ...over,
  };
}

function turn(over: Partial<TurnResult> = {}): TurnResult {
  return {
    input: "I use the feat!",
    narrative: "",
    checks: [],
    finalState: null,
    toolLines: [],
    errorLines: [],
    seconds: 10,
    ...over,
  };
}

/** Estado de combate com o jogador em N ações restantes e reação disponível. */
function state(opts: { actions?: number; reaction?: boolean; active?: boolean } = {}) {
  return {
    combat: {
      active: opts.active ?? true,
      combatants: [
        {
          kind: "player",
          actionsRemaining: opts.actions ?? 2,
          reactionAvailable: opts.reaction ?? true,
        },
        { kind: "enemy", actionsRemaining: 3, reactionAvailable: true },
      ],
    },
  };
}

const enemyHit = {
  label: "Bandit Machete Strike vs Ferro (AC 22)",
  die: 15,
  total: 20,
  dc: 22,
  degree: "success",
  attack: {
    attacker: "Bandit",
    target: "Ferro",
    attackerKind: "enemy",
    outcome: "hit",
    damage: 7,
    damageType: "slashing",
  },
};

const toolOk = (name: string, args: string, result = "ok") =>
  `[GM][rules]   tool ${name}(${args}) -> ${result}`;

// ---------------------------------------------------------------------------
// narratesLandedBlow — o falso positivo documentado
// ---------------------------------------------------------------------------

describe("narratesLandedBlow", () => {
  it("REGRESSÃO Flying Blade: o golpe que ERRA e crava no chão não é acusado", () => {
    // A string real que derrubou o cenário no gate de 26/07.
    expect(
      narratesLandedBlow(
        "You hurl the dagger, the blade missing your chest by mere inches as it bites into the dirt.",
      ),
    ).toBe(false);
  });

  it("acusa golpe que de fato conecta", () => {
    expect(narratesLandedBlow("Your blade sinks into his shoulder.")).toBe(true);
    expect(narratesLandedBlow("The axe bites into his ribs with a wet crunch.")).toBe(true);
  });

  it("entende as formas de negação e de defesa do alvo", () => {
    const negados = [
      "Your blade never sinks into anything; he twists away.",
      "The strike fails to bite into his guard.",
      "Steel slams into the shield, but the blow is deflected wide.",
      "He dodges as your dagger pierces only air.",
      "Your sword nearly connects, then he parries.",
      "The blow doesn't land squarely — it glances off his pauldron.",
    ];
    for (const s of negados) {
      expect(narratesLandedBlow(s), s).toBe(false);
    }
  });

  it("negação numa frase NÃO inocenta um golpe que conecta em outra", () => {
    // O primeiro ataque erra; o segundo acerta. Tem que acusar.
    expect(
      narratesLandedBlow(
        "The first swing misses wide. Then your blade sinks into his thigh.",
      ),
    ).toBe(true);
  });

  it("narrativa sem golpe algum não é acusada", () => {
    expect(narratesLandedBlow("You circle him warily, watching his footing.")).toBe(false);
    expect(narratesLandedBlow("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// featNamedInTools
// ---------------------------------------------------------------------------

describe("featNamedInTools", () => {
  it("acha o feat nos ARGUMENTOS de uma tool aceita", () => {
    const lines = [toolOk("roll_check", '{"reason":"Using Nimble Dodge to avoid it"}')];
    expect(featNamedInTools(lines, "Nimble Dodge")).toBe(true);
  });

  it("IGNORA o nome que aparece só no RESULTADO da tool", () => {
    // A engine ecoa o nome ao REJEITAR — citar não é usar.
    const lines = [
      toolOk("roll_check", '{"reason":"I attack"}', 'ILLEGAL: "Nimble Dodge" is a REACTION'),
    ];
    expect(featNamedInTools(lines, "Nimble Dodge")).toBe(false);
  });

  it("ignora tool com erro e casa ignorando caixa/pontuação", () => {
    expect(
      featNamedInTools([`[GM][rules]   tool x({"r":"Nimble Dodge"}) -> ERROR: nope`], "Nimble Dodge"),
    ).toBe(false);
    expect(featNamedInTools([toolOk("x", '{"r":"nimble  dodge!"}')], "Nimble Dodge")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// assertUsage — a asserção por tipo de feat
// ---------------------------------------------------------------------------

describe("assertUsage — reação", () => {
  it("gatilho servido e reação intacta = uso AUSENTE (a lacuna real do jogo)", () => {
    const t = turn({ checks: [enemyHit], finalState: state({ reaction: true }) });
    const u = assertUsage(scenario(), [t]);
    expect(u.kind).toBe("missing");
    expect(u.kind === "missing" && u.why).toMatch(/gatilho servido/);
  });

  it("reação consumida = uso CONFIRMADO", () => {
    const t = turn({ checks: [enemyHit], finalState: state({ reaction: false }) });
    expect(assertUsage(scenario(), [t]).kind).toBe("confirmed");
  });

  it("sem gatilho no turno, o juiz NÃO culpa o modelo", () => {
    const t = turn({ checks: [], finalState: state({ reaction: true }) });
    const u = assertUsage(scenario(), [t]);
    expect(u.kind).toBe("not-asserted");
    expect(u.kind === "not-asserted" && u.why).toMatch(/gatilho não ocorreu/);
  });

  it("reação registrada pela engine em check conta como uso", () => {
    const t = turn({
      checks: [{ ...enemyHit, label: "Reaction (Nimble Dodge): Ferro vs Bandit" }],
      finalState: state({ reaction: true }),
    });
    expect(assertUsage(scenario(), [t]).kind).toBe("confirmed");
  });
});

describe("assertUsage — free, passivo e ação", () => {
  const free = scenario({ name: "Exotic Edge", actionType: "free", archetype: "skill-activity" });

  it("free action: só o nome nos argumentos serve de evidência", () => {
    expect(assertUsage(free, [turn()]).kind).toBe("missing");
    expect(
      assertUsage(free, [turn({ toolLines: [toolOk("roll_check", '{"reason":"Exotic Edge"}')] })])
        .kind,
    ).toBe("confirmed");
  });

  it("passivo NÃO implementado pela engine é ponto cego DECLARADO, não aprovação", () => {
    const p = scenario({ name: "Acute Vision", actionType: "passive", side: "noncombat" });
    const u = assertUsage(p, [turn()]);
    expect(u.kind).toBe("not-asserted");
    expect(u.kind === "not-asserted" && u.why).toMatch(/sem efeito mecânico implementado/);
  });

  it("passivo implementado pela engine é verificado em TODOS os turnos", () => {
    // A iniciativa é rolada no start_combat do turno 1; o turno de uso é o 2.
    const p = scenario({ name: "Incredible Initiative", actionType: "passive", archetype: "passivo-combate" });
    const t1 = turn({
      toolLines: [toolOk("start_combat", "{}", "Combat started. [+2 initiative from Incredible Initiative]")],
    });
    expect(assertUsage(p, [t1, turn()]).kind).toBe("confirmed");
    expect(assertUsage(p, [turn(), turn()]).kind).toBe("missing");
  });

  it("ação: custo cobrado é evidência suficiente", () => {
    const a = scenario({ name: "Sudden Charge", actionType: "action", actionCost: 2, archetype: "movimento-tatico" });
    expect(assertUsage(a, [turn({ finalState: state({ actions: 1 }) })]).kind).toBe("confirmed");
    expect(assertUsage(a, [turn({ finalState: state({ actions: 3 }) })]).kind).toBe("missing");
  });
});

// ---------------------------------------------------------------------------
// engineDeclaredVoid — o segundo falso positivo documentado
// ---------------------------------------------------------------------------

describe("engine declarando o vazio (doutrina 4)", () => {
  const VOID_SUMMARY =
    "NOTHING was resolved mechanically this turn: the rules were consulted but no check was rolled, no cost was paid and no effect was applied.";
  const wayfinder = scenario({
    name: "Esoteric Wayfinder",
    actionType: "free",
    side: "noncombat",
    archetype: "skill-activity",
  });

  it("REGRESSÃO Esoteric Wayfinder: engine que avisa o vazio não é acusada", () => {
    // Free action de EXPLORAÇÃO exercitada numa taverna: o feat não se aplica,
    // o modelo disse isso e a engine declarou ao narrador. Nada aqui é defeito
    // do jogo — é o cenário que não criou as condições.
    const v = judge(wayfinder, [
      turn({
        toolLines: [toolOk("lookup_rule", '{"query":"Esoteric Wayfinder"}')],
        mechanicalSummary: VOID_SUMMARY,
      }),
    ]);
    expect(v.verdict).toBe("PASS");
    expect(v.usage.kind).toBe("not-asserted");
    expect(v.usage.kind === "not-asserted" && v.usage.why).toMatch(/nada se aplicava/);
  });

  it("SEM a declaração da engine, o mesmo turno segue suspeito", () => {
    const v = judge(wayfinder, [
      turn({ toolLines: [toolOk("lookup_rule", '{"query":"Esoteric Wayfinder"}')] }),
    ]);
    expect(v.verdict).toBe("SUSPECT");
  });

  it("a declaração de vazio NÃO absolve reação com gatilho servido", () => {
    // Em combate o gatilho é observável: se o inimigo atacou e a reação segue
    // disponível, o feat não foi usado — declarar o vazio não muda esse fato.
    const v = judge(scenario(), [
      turn({
        checks: [enemyHit],
        finalState: state({ reaction: true }),
        mechanicalSummary: "NOTHING was resolved this turn: no attack happened.",
      }),
    ]);
    expect(v.verdict).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// judge — veredito
// ---------------------------------------------------------------------------

describe("judge", () => {
  it("reação não usada vira FAIL (evidência de estado)", () => {
    const v = judge(scenario(), [turn({ checks: [enemyHit], finalState: state({ reaction: true }) })]);
    expect(v.verdict).toBe("FAIL");
    expect(v.notes.join(" ")).toMatch(/feat NÃO usado/);
  });

  it("free action ausente vira SUSPECT (evidência fraca), não FAIL", () => {
    const v = judge(
      scenario({ name: "Exotic Edge", actionType: "free", side: "noncombat", archetype: "skill-activity" }),
      [turn({ checks: [{ ...enemyHit, attack: null }] })],
    );
    expect(v.verdict).toBe("SUSPECT");
  });

  it("FAIL nunca é promovido de volta a SUSPECT/PASS", () => {
    const v = judge(scenario(), [
      turn({
        checks: [enemyHit, { ...enemyHit, attack: null, dc: 2 }],
        finalState: state({ reaction: true }),
        errorLines: ["x -> ERROR"],
        toolLines: ["x -> ERROR"],
      }),
    ]);
    expect(v.verdict).toBe("FAIL");
  });

  it("cenário íntegro passa e reporta a evidência do uso", () => {
    const a = scenario({ name: "Sudden Charge", actionType: "action", actionCost: 2, archetype: "movimento-tatico" });
    const v = judge(a, [
      turn({
        finalState: state({ actions: 1 }),
        toolLines: [toolOk("roll_check", '{"reason":"Sudden Charge"}')],
        narrative: "You close the gap and your blade sinks into his side.",
        checks: [
          { ...enemyHit, attack: { ...enemyHit.attack, attackerKind: "player", outcome: "hit" } },
        ],
      }),
    ]);
    expect(v.verdict).toBe("PASS");
    expect(v.usage.kind).toBe("confirmed");
  });

  it("custo de ação não cobrado continua FAIL", () => {
    const a = scenario({ name: "Sudden Charge", actionType: "action", actionCost: 2, archetype: "movimento-tatico" });
    const v = judge(a, [
      turn({ finalState: state({ actions: 3 }), toolLines: [toolOk("roll_check", '{"reason":"Sudden Charge"}')] }),
    ]);
    expect(v.verdict).toBe("FAIL");
    expect(v.notes.join(" ")).toMatch(/custo de ação não cobrado/);
  });

  it("dupla contagem (hit da engine + hpDelta manual aceito) é FAIL", () => {
    const a = scenario({ name: "Twin Feint", actionType: "action", actionCost: 2, archetype: "atividade-multi-strike" });
    const v = judge(a, [
      turn({
        finalState: state({ actions: 1 }),
        checks: [{ ...enemyHit, attack: { ...enemyHit.attack, attackerKind: "player" } }],
        toolLines: [toolOk("update_state", '{"hpDelta":-7,"target":"Bandit"}')],
      }),
    ]);
    expect(v.verdict).toBe("FAIL");
    expect(v.notes.join(" ")).toMatch(/dupla contagem/);
  });
});
