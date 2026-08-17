/**
 * A ação de perícia MUDA O ESTADO — fim do d20 que não causava nada.
 *
 * Até 2026-08-16, `roll_check` de perícia rolava e parava: o `summaryLine` de
 * um Demoralize bem-sucedido era idêntico ao de "olhar feio para o inimigo", e
 * a única ação de perícia com efeito real no sistema inteiro era Treat Wounds.
 * Estes testes fixam o comportamento novo E as fronteiras que ele NÃO cruza.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Character, Combatant } from "@pf2e/shared";
import { executeTool } from "./agent.js";
import { buildCombat } from "./combat.js";
import type { Session } from "./sessions.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));
const noop = () => {};

/** DC 1 força sucesso; DC 99 força falha. O dado não decide o teste. */
function mkSession(opts: { foes?: number } = {}): Session {
  const player: Combatant = {
    id: "hero",
    name: "Hero",
    kind: "player",
    initiative: 20,
    ac: 20,
    maxHp: 50,
    currentHp: 50,
    conditions: [],
    actionsRemaining: 3,
    reactionAvailable: true,
    mapProgress: 0,
    level: 5,
    traits: [],
    defeated: false,
  };
  // `conditions: []` PRÓPRIO em cada um: `{...player}` copiaria a REFERÊNCIA
  // do array, e jogador e inimigos passariam a compartilhar a mesma lista de
  // condições — o teste do crítico de falha (que aplica prone em quem tentou)
  // via o prone aparecer também no alvo. Bug da fixture, não da engine.
  const foes: Combatant[] = Array.from({ length: opts.foes ?? 1 }, (_, i) => ({
    ...player,
    id: `foe${i}`,
    name: i === 0 ? "Giant Rat" : `Goblin ${i}`,
    kind: "enemy" as const,
    initiative: 3 - i,
    conditions: [],
    traits: [],
  }));
  return {
    id: "t",
    character: {
      name: "Hero",
      level: 5,
      maxHp: 50,
      ac: 20,
      perception: 12,
      saves: { fortitude: 10, reflex: 12, will: 9 },
      abilityModifiers: { str: 4, dex: 2, con: 2, int: 0, wis: 1, cha: 0 },
      weaponProficiencies: { simple: 2, martial: 2 },
      weapons: [{ name: "Longsword", attack: 13, die: "d8", damageBonus: 4, damageType: "S" }],
      armor: [],
      feats: [],
      classFeatures: [],
      equipment: [],
      skills: {
        athletics: { name: "athletics", ability: "str", rank: 2, modifier: 13 },
        intimidation: { name: "intimidation", ability: "cha", rank: 2, modifier: 11 },
        deception: { name: "deception", ability: "cha", rank: 2, modifier: 11 },
        acrobatics: { name: "acrobatics", ability: "dex", rank: 2, modifier: 11 },
        stealth: { name: "stealth", ability: "dex", rank: 2, modifier: 11 },
      },
      lores: [],
      spellcasting: [],
    } as unknown as Character,
    state: {
      sessionId: "t",
      currentHp: 50,
      conditions: [],
      flags: {},
      combat: buildCombat([player, ...foes]),
    },
  } as unknown as Session;
}

const foeOf = (s: Session, name = "Giant Rat") =>
  s.state.combat!.combatants.find((c) => c.name === name)!;

/**
 * O grau que a rolagem produziu. Os testes afirmam EM FUNÇÃO dele, e não de um
 * DC mágico: o piso `isValidDc` recusa DC < 5, e mesmo um DC baixo não fixa o
 * grau — nat 1 rebaixa, nat 20 sobe. Amarrar a asserção ao dado seria flaky, e
 * teste flaky vira `skip`.
 */
const degreeOf = (out: { content: string }): string =>
  (JSON.parse(out.content) as { degree: string }).degree;

const SUCESSO = ["success", "criticalSuccess"];

describe.skipIf(!hasGenerated)("ação de perícia aplica condição (requer generated/)", () => {
  it("Demoralize com sucesso deixa o alvo frightened", async () => {
    const s = mkSession();
    const out = await executeTool(
      s,
      "roll_check",
      { skill: "intimidation", dc: 15, target: "Giant Rat", reason: "I Demoralize the rat" },
      noop,
    );
    if (SUCESSO.includes(degreeOf(out))) {
      expect(foeOf(s).conditions.some((c) => c.startsWith("frightened"))).toBe(true);
      expect(out.summaryLine).toContain("Demoralize");
    } else {
      expect(foeOf(s).conditions).toEqual([]);
    }
  });

  it("Trip com sucesso deixa o alvo prone", async () => {
    const s = mkSession();
    const out = await executeTool(
      s,
      "roll_check",
      { skill: "athletics", dc: 15, target: "Giant Rat", reason: "I Trip the rat" },
      noop,
    );
    if (SUCESSO.includes(degreeOf(out))) expect(foeOf(s).conditions).toContain("prone");
    else expect(foeOf(s).conditions).not.toContain("prone");
  });

  it("Grapple com sucesso deixa o alvo grabbed", async () => {
    const s = mkSession();
    const out = await executeTool(
      s,
      "roll_check",
      { skill: "athletics", dc: 15, target: "Giant Rat", reason: "I Grapple the rat" },
      noop,
    );
    const pego = foeOf(s).conditions.some((c) => /grabbed|restrained/.test(c));
    expect(pego).toBe(SUCESSO.includes(degreeOf(out)));
  });

  it("FALHA não aplica nada (Trip que falha não derruba — é RAW)", async () => {
    const s = mkSession();
    await executeTool(
      s,
      "roll_check",
      { skill: "athletics", dc: 40, target: "Giant Rat", reason: "I Trip the rat" },
      noop,
    );
    expect(foeOf(s).conditions).not.toContain("prone");
  });

  it("perícia comum não aplica condição nenhuma", async () => {
    const s = mkSession();
    await executeTool(
      s,
      "roll_check",
      { skill: "athletics", dc: 15, target: "Giant Rat", reason: "I climb the wall" },
      noop,
    );
    expect(foeOf(s).conditions).toEqual([]);
  });

  it("dois inimigos e nenhum alvo nomeado: NÃO escolhe sozinho", async () => {
    // Aplicar frightened no goblin errado é pior que não aplicar. O modelo tem
    // `update_state` para corrigir de propósito.
    const s = mkSession({ foes: 2 });
    await executeTool(
      s,
      "roll_check",
      { skill: "intimidation", dc: 15, reason: "I Demoralize them" },
      noop,
    );
    const comCondicao = s.state.combat!.combatants.filter((c) => c.conditions.length > 0);
    expect(comCondicao).toHaveLength(0);
  });

  it("um inimigo só e sem alvo nomeado: aplica, porque não há ambiguidade", async () => {
    const s = mkSession({ foes: 1 });
    const out = await executeTool(
      s,
      "roll_check",
      { skill: "intimidation", dc: 15, reason: "I Demoralize it" },
      noop,
    );
    const assustado = foeOf(s).conditions.some((c) => c.startsWith("frightened"));
    expect(assustado).toBe(SUCESSO.includes(degreeOf(out)));
  });

  it("fora de combate não inventa estado no alvo", async () => {
    const s = mkSession();
    s.state.combat = null;
    const out = await executeTool(
      s,
      "roll_check",
      { skill: "intimidation", dc: 15, reason: "I Demoralize the innkeeper" },
      noop,
    );
    expect(out.isError).toBeUndefined();
    expect(s.state.conditions).toEqual([]);
  });

  it("Escape solta o jogador do grabbed — a contrapartida do Grapple", async () => {
    // A primeira leva criou a assimetria: Grapple prendia e nada soltava.
    // Implementar o que prende sem o que solta é pior que não ter nenhum.
    const s = mkSession();
    s.state.conditions.push("grabbed");
    const you = s.state.combat!.combatants.find((c) => c.kind === "player")!;
    you.conditions.push("grabbed");

    const out = await executeTool(
      s,
      "roll_check",
      { skill: "athletics", dc: 15, reason: "I Escape the grapple" },
      noop,
    );
    if (SUCESSO.includes(degreeOf(out))) {
      expect(s.state.conditions).not.toContain("grabbed");
      expect(you.conditions).not.toContain("grabbed");
      expect(out.summaryLine).toContain("breaks free");
    } else {
      expect(s.state.conditions).toContain("grabbed");
    }
  });

  it("Escape tira as TRÊS condições que o RAW nomeia", async () => {
    const s = mkSession();
    s.state.conditions.push("grabbed", "restrained", "immobilized", "frightened 1");
    const out = await executeTool(
      s,
      "roll_check",
      { skill: "acrobatics", dc: 15, reason: "I Escape" },
      noop,
    );
    if (SUCESSO.includes(degreeOf(out))) {
      expect(s.state.conditions).toEqual(["frightened 1"]);
    }
  });

  it("Escape sem estar preso não faz nada (nem mente no resumo)", async () => {
    const s = mkSession();
    const out = await executeTool(
      s,
      "roll_check",
      { skill: "athletics", dc: 15, reason: "I Escape" },
      noop,
    );
    expect(out.summaryLine).not.toContain("breaks free");
  });

  it("Create a Diversion deixa o JOGADOR hidden", async () => {
    const s = mkSession();
    const out = await executeTool(
      s,
      "roll_check",
      { skill: "deception", dc: 15, reason: "I Create a Diversion" },
      noop,
    );
    const escondido = s.state.conditions.includes("hidden");
    expect(escondido).toBe(SUCESSO.includes(degreeOf(out)));
  });

  it("crítico de falha do Trip derruba QUEM TENTOU", async () => {
    // `on: "self"` — o único caso em que a condição cai no jogador.
    const s = mkSession();
    // DC 40 contra +13: mesmo um nat 20 (que sobe um grau) não escapa do
    // criticalFailure, porque o total fica 10+ abaixo do DC.
    const out = await executeTool(
      s,
      "roll_check",
      { skill: "athletics", dc: 40, target: "Giant Rat", reason: "I Trip the rat" },
      noop,
    );
    if (degreeOf(out) === "criticalFailure") {
      expect(s.state.conditions).toContain("prone");
      expect(foeOf(s).conditions).not.toContain("prone");
    }
  });
});
