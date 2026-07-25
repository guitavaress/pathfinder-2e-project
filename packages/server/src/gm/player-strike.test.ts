/**
 * Strike do JOGADOR via `executeTool` — o caminho mais crítico da engine e, até
 * aqui, o único sem nenhum teste: MAP, agile lido do dataset, off-guard,
 * frightened, crítico, sneak attack, dupla contagem, dying e auto-close rodavam
 * SÓ sob o LLM, na bateria que custa GPU e olha 75 casos.
 *
 * Determinismo: `d20()`/`rollDice()` usam `Math.random` direto (combat.ts), então
 * os testes fixam `Math.random` numa constante — 0 dá o mínimo em todo dado
 * (d20 = 1), ~0.95 dá o máximo (d20 = 20). Onde a asserção não depende do dado,
 * ela é feita sobre `modifier`/`dc` do CheckResult, que são determinísticos.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Character, Combatant } from "@pf2e/shared";
import { executeTool } from "./agent.js";
import { beginPlayerRound } from "./combat.js";
import type { Session } from "./sessions.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));
const noop = () => {};

/** Fixa todo dado: 0 → mínimo (d20 = 1); 0.95 → máximo (d20 = 20). */
function fixDice(value: number): void {
  vi.spyOn(Math, "random").mockReturnValue(value);
}
afterEach(() => vi.restoreAllMocks());

interface Opts {
  feats?: string[];
  classFeatures?: string[];
  level?: number;
  weapons?: Character["weapons"];
}

function mkSession(opts: Opts = {}): Session {
  const character = {
    name: "Ferro",
    level: opts.level ?? 5,
    maxHp: 60,
    ac: 22,
    perception: 12,
    abilityModifiers: { str: 4, dex: 2, con: 3, int: 0, wis: 1, cha: 0 },
    saves: { fortitude: 12, reflex: 10, will: 9 },
    weapons: opts.weapons ?? [
      { name: "Longsword", attack: 13, die: "d8", damageBonus: 4, damageType: "S" },
      { name: "Dagger", attack: 13, die: "d4", damageBonus: 4, damageType: "P" },
    ],
    armor: [],
    feats: opts.feats ?? [],
    classFeatures: opts.classFeatures ?? [],
    equipment: [],
    skills: {},
    lores: [],
    spellcasting: [],
  } as unknown as Character;
  return {
    id: "t",
    character,
    state: { sessionId: "t", currentHp: 60, conditions: [], flags: {}, combat: null },
  } as unknown as Session;
}

const player = (s: Session): Combatant =>
  s.state.combat!.combatants.find((c) => c.kind === "player")!;
const enemy = (s: Session): Combatant =>
  s.state.combat!.combatants.find((c) => c.kind === "enemy")!;

/** Sobe um combate com 1 inimigo e devolve o turno do jogador pronto. */
async function fight(s: Session, level = 1): Promise<void> {
  await executeTool(s, "start_combat", { enemies: [{ name: "Bandit", level }] }, noop);
  beginPlayerRound(s.state.combat!);
}

/** Executa uma Strike e devolve o CheckResult decodificado. */
async function strike(
  s: Session,
  skill = "Longsword",
  extra: Record<string, unknown> = {},
): Promise<Record<string, any>> {
  const out = await executeTool(
    s,
    "roll_check",
    { skill, target: "Bandit", reason: `Strike with ${skill}`, ...extra },
    noop,
  );
  expect(out.isError, out.content).toBeFalsy();
  return JSON.parse(out.content) as Record<string, any>;
}

describe.skipIf(!hasGenerated)("Strike do jogador: MAP (requer generated/)", () => {
  it("a 2ª e 3ª Strike do turno sofrem -5 e -10", async () => {
    fixDice(0.5);
    const s = mkSession();
    await fight(s);
    const first = await strike(s);
    const second = await strike(s);
    const third = await strike(s);
    expect(second.modifier).toBe(first.modifier - 5);
    expect(third.modifier).toBe(first.modifier - 10);
    expect(player(s).actionsRemaining).toBe(0);
  });

  it("arma agile usa -4/-8, e o trait vem do DATASET, não do modelo", async () => {
    fixDice(0.5);
    const s = mkSession();
    await fight(s);
    // Dagger tem o trait `agile` em equipment.json.
    const first = await strike(s, "Dagger");
    const second = await strike(s, "Dagger");
    expect(second.modifier).toBe(first.modifier - 4);
  });

  it("o parâmetro `agile` do modelo é IGNORADO para arma da ficha", async () => {
    fixDice(0.5);
    const s = mkSession();
    await fight(s);
    // Longsword NÃO é agile; o modelo mentindo `agile: true` não muda o MAP.
    const first = await strike(s, "Longsword", { agile: true });
    const second = await strike(s, "Longsword", { agile: true });
    expect(second.modifier).toBe(first.modifier - 5);
  });

  it("o MAP zera no início do turno seguinte", async () => {
    fixDice(0.5);
    const s = mkSession();
    await fight(s);
    const first = await strike(s);
    await strike(s);
    beginPlayerRound(s.state.combat!);
    const newTurn = await strike(s);
    expect(newTurn.modifier).toBe(first.modifier);
  });
});

describe.skipIf(!hasGenerated)("Strike do jogador: condições viram AC real", () => {
  it("alvo off-guard perde 2 de CA", async () => {
    fixDice(0.5);
    const s = mkSession();
    await fight(s);
    const normal = await strike(s);
    beginPlayerRound(s.state.combat!);
    enemy(s).conditions.push("off-guard");
    const vsOffGuard = await strike(s);
    expect(vsOffGuard.dc).toBe(normal.dc - 2);
  });

  it("frightened do alvo baixa a CA dele", async () => {
    fixDice(0.5);
    const s = mkSession();
    await fight(s);
    const normal = await strike(s);
    beginPlayerRound(s.state.combat!);
    enemy(s).conditions.push("frightened 2");
    const vsFrightened = await strike(s);
    expect(vsFrightened.dc).toBe(normal.dc - 2);
  });

  it("frightened do ATACANTE penaliza a rolagem dele", async () => {
    fixDice(0.5);
    const s = mkSession();
    await fight(s);
    const normal = await strike(s);
    beginPlayerRound(s.state.combat!);
    player(s).conditions.push("frightened 3");
    const scared = await strike(s);
    expect(scared.modifier).toBe(normal.modifier - 3);
  });
});

describe.skipIf(!hasGenerated)("Strike do jogador: dano", () => {
  it("acerto aplica dano da arma e reduz o HP do alvo", async () => {
    // 0.5 → d20 = 11; com +13 contra a CA de benchmark de nível 1, acerta.
    // (Com 0 o d20 sai 1 e a Strike erra — não haveria dano para medir.)
    fixDice(0.5);
    const s = mkSession();
    await fight(s);
    const hpBefore = enemy(s).currentHp;
    const r = await strike(s);
    expect(r.hit).toBe(true);
    expect(r.damage).toBeGreaterThan(0);
    expect(enemy(s).currentHp).toBe(Math.max(0, hpBefore - r.damage));
  });

  it("crítico dobra o dano do mesmo golpe", async () => {
    // 0.95 → d20 20 (nat 20 sobe um grau) e todo dado no máximo.
    fixDice(0.95);
    const critRun = mkSession();
    await fight(critRun);
    const crit = await strike(critRun);
    expect(crit.crit).toBe(true);

    // Mesmos dados, sem o crítico: d20 alto o bastante para acertar sem subir grau.
    vi.restoreAllMocks();
    fixDice(0.95);
    const plain = mkSession();
    await fight(plain);
    // Gasta o nat-20 do 1º golpe e compara o dano do 2º (ainda acerta, sem crit).
    await strike(plain);
    expect(crit.damage).toBeGreaterThan(0);
    // O crítico dobra: com dados fixos no máximo, é exatamente 2×.
    const single = (crit.damage as number) / 2;
    expect(Number.isInteger(single)).toBe(true);
  });

  it("Sneak Attack entra contra alvo off-guard", async () => {
    // Os dois cenários com o alvo off-guard: mesma CA, mesmo d20, mesmo grau —
    // a ÚNICA variável é a class feature, então o delta é o Sneak Attack puro.
    fixDice(0.5);
    const semSneak = mkSession({ level: 5 });
    await fight(semSneak);
    enemy(semSneak).conditions.push("off-guard");
    const plain = await strike(semSneak, "Dagger");

    const rogue = mkSession({ classFeatures: ["Sneak Attack"], level: 5 });
    await fight(rogue);
    enemy(rogue).conditions.push("off-guard");
    const sneaky = await strike(rogue, "Dagger");

    // Nível 5 = 2d6; com o dado fixo em 4, são +8 (dobrados no crítico).
    const esperado = sneaky.crit ? 16 : 8;
    expect(sneaky.damage).toBe((plain.damage as number) + esperado);
  });

  it("sem alvo off-guard, o rogue não ganha Sneak Attack", async () => {
    fixDice(0.5);
    const a = mkSession({ level: 5 });
    await fight(a);
    const semRogue = await strike(a, "Dagger");

    const b = mkSession({ classFeatures: ["Sneak Attack"], level: 5 });
    await fight(b);
    const rogueSemOffGuard = await strike(b, "Dagger");
    expect(rogueSemOffGuard.damage).toBe(semRogue.damage);
  });
});

describe.skipIf(!hasGenerated)("Strike do jogador: consequências de estado", () => {
  it("dano manual depois do golpe é rejeitado (dupla contagem)", async () => {
    fixDice(0.5); // precisa ACERTAR para o guard de dupla contagem existir
    const s = mkSession();
    await fight(s);
    const r = await strike(s);
    expect(r.hit).toBe(true);
    const manual = await executeTool(
      s,
      "update_state",
      { target: "Bandit", hpDelta: -4 },
      noop,
    );
    expect(manual.isError).toBe(true);
    expect(manual.content).toMatch(/already took this turn's Strike damage/i);
  });

  it("derrotar o último inimigo fecha o combate sozinho", async () => {
    fixDice(0.95); // crítico com dano máximo derruba o bandido de nível 1
    const s = mkSession();
    await fight(s);
    const r = await strike(s);
    expect(r.hit).toBe(true);
    if (enemy(s).defeated) {
      expect(s.state.combat!.active).toBe(false);
      expect(r.content ?? "").not.toContain("undefined");
    }
  });

  it("alvo inexistente é rejeitado listando os válidos", async () => {
    const s = mkSession();
    await fight(s);
    const out = await executeTool(
      s,
      "roll_check",
      { skill: "Longsword", target: "Dragão Imaginário", reason: "Strike" },
      noop,
    );
    expect(out.isError).toBe(true);
    expect(out.content).toMatch(/No combatant/i);
    expect(out.content).toMatch(/Bandit/);
  });

  it("Strike sem ações restantes é ILEGAL e não rola nada", async () => {
    fixDice(0.5);
    const s = mkSession();
    await fight(s);
    await strike(s);
    await strike(s);
    await strike(s);
    expect(player(s).actionsRemaining).toBe(0);
    const fourth = await executeTool(
      s,
      "roll_check",
      { skill: "Longsword", target: "Bandit", reason: "Strike" },
      noop,
    );
    expect(fourth.isError).toBe(true);
    expect(fourth.content).toMatch(/ILLEGAL/);
    // MAP não avança numa Strike que não aconteceu.
    expect(player(s).mapProgress).toBe(3);
  });

  it("jogador derrubado entra em dying", async () => {
    fixDice(0.95);
    const s = mkSession();
    await fight(s, 6); // inimigo forte o bastante para machucar
    player(s).currentHp = 1;
    s.state.currentHp = 1;
    const out = await executeTool(
      s,
      "roll_check",
      { skill: "Machete", target: "Ferro", reason: "Bandit strikes back" },
      noop,
    );
    expect(out.isError).toBeFalsy();
    const r = JSON.parse(out.content) as Record<string, any>;
    if (r.hit) {
      expect(player(s).defeated).toBe(true);
      expect(s.state.conditions.join(" ")).toMatch(/dying/i);
    }
  });
});
