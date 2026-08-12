/**
 * Como o efeito ENTRA no registro (Fase 2.6 / T6.3).
 *
 * Três pontes, todas aferidas no dado: `selfEffect` explícito (242 feats),
 * stance homônima (78 de 86) e magia BENIGNA homônima (318 de 381 — as 63 com
 * ataque ou save ficam fora porque o efeito delas incide em quem foi atingido).
 *
 * O que mais importa aqui é o que NÃO concede: magia hostil, alvo inimigo,
 * ability que não está na ficha, nome que o dado não conhece.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Character, Combatant, GameState } from "@pf2e/shared";
import { executeTool } from "./agent.js";
import { buildCombat } from "./combat.js";
import type { Session } from "./sessions.js";
import { mentionedSelfEffect, selfEffectOf } from "../rules/active-effects.js";
import { byUuid, categoryRecords, lookupLocalRule } from "../rules/dataset.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));

const noop = () => {};

function mkCharacter(over: Partial<Record<string, unknown>> = {}): Character {
  return {
    name: "Jão",
    level: 5,
    maxHp: 65,
    ac: 22,
    perception: 11,
    abilityModifiers: { str: 4, dex: 2, con: 2, int: 0, wis: 1, cha: 0 },
    saves: { fortitude: 11, reflex: 15, will: 10 },
    weapons: [],
    armor: [],
    feats: [],
    classFeatures: [],
    equipment: [],
    skills: {},
    lores: [],
    spellcasting: [],
    ...over,
  } as unknown as Character;
}

function mk(partial: Partial<Combatant> & Pick<Combatant, "name" | "kind">): Combatant {
  return {
    id: partial.name.toLowerCase().replace(/\s+/g, "-"),
    initiative: 10,
    ac: 15,
    maxHp: 40,
    currentHp: 40,
    conditions: [],
    actionsRemaining: 3,
    reactionAvailable: true,
    mapProgress: 0,
    level: 1,
    traits: [],
    defeated: false,
    ...partial,
  };
}

function sessionWith(character: Character, ...combatants: Combatant[]): Session {
  const state: GameState = {
    sessionId: "t",
    currentHp: 65,
    conditions: [],
    flags: {},
    combat: combatants.length ? buildCombat(combatants) : null,
  };
  return { id: "t", state, character, messages: [] } as unknown as Session;
}

describe.skipIf(!hasGenerated)("byUuid — a referência do dado vem por NOME", () => {
  it("resolve o último segmento como nome, não só como id", () => {
    // O fonte do pf2e escreve as referências por nome e só as converte em id no
    // build do compêndio. Importamos o fonte: dos 1.248 GrantItem de
    // ficha/efeito sem template, 1.247 resolvem por NOME.
    const hit = byUuid("Compendium.pf2e.feats-srd.Item.Breath Control");
    expect(hit?.name).toBe("Breath Control");
  });

  it("id continua resolvendo (é como os 242 selfEffect chegam)", () => {
    const flight = categoryRecords("feats").find((f) => f.name === "Flight" && f.selfEffect);
    expect(flight?.selfEffect).toBeTruthy();
    expect(byUuid(flight!.selfEffect!)?.category).toBe("effects");
  });

  it("referência que não existe segue devolvendo null", () => {
    expect(byUuid("Compendium.pf2e.feats-srd.Item.Golpe do Dragão Interior")).toBeNull();
  });

  it("TODO GrantItem de ficha sem template resolve — nenhum cai no vazio", () => {
    let semTemplate = 0;
    let resolvido = 0;
    for (const category of ["feats", "classes", "heritages", "ancestries", "backgrounds"] as const) {
      for (const rec of categoryRecords(category)) {
        for (const raw of (rec.rules ?? []) as Record<string, unknown>[]) {
          if (raw.key !== "GrantItem" || typeof raw.uuid !== "string") continue;
          if (raw.uuid.includes("{")) continue; // depende de ChoiceSet
          semTemplate++;
          if (byUuid(raw.uuid)) resolvido++;
        }
      }
    }
    expect(semTemplate).toBeGreaterThan(900);
    expect(resolvido).toBe(semTemplate);
  });
});

describe.skipIf(!hasGenerated)("selfEffectOf — as três pontes, e o que fica fora", () => {
  const feat = (name: string) => categoryRecords("feats").find((f) => f.name === name)!;

  it("selfEffect explícito é a ponte mais confiável", () => {
    expect(selfEffectOf(feat("Flight"))?.name).toBe("Effect: Spirit Power (Flight)");
  });

  it("stance homônima entra — é onde vive o Arcane Cascade", () => {
    const action = categoryRecords("actions").find((a) => a.name === "Arcane Cascade")!;
    expect(selfEffectOf(action)).toMatchObject({
      name: "Stance: Arcane Cascade",
      slug: "arcane-cascade",
      unit: "encounter",
    });
  });

  it("magia benigna homônima entra, com a duração do dado", () => {
    expect(selfEffectOf(lookupLocalRule("Heroism")!)).toMatchObject({
      name: "Spell Effect: Heroism",
      unit: "minutes",
      value: 10,
    });
  });

  it("magia HOSTIL não põe o próprio efeito no conjurador", () => {
    // Ill Omen tem save de Vontade: `Spell Effect: Ill Omen` é penalidade, e cai
    // em quem foi atingido. Concedê-la ao conjurador inventaria um castigo.
    const illOmen = lookupLocalRule("Ill Omen")!;
    expect(illOmen.spell?.defense?.save).toBe("will");
    expect(selfEffectOf(illOmen)).toBeNull();
  });

  it("ação não-stance com effect homônimo fica FORA (o alvo é indefinido)", () => {
    // Hunt Prey marca a PRESA, não o caçador — e o import não carrega em quem o
    // efeito incide. Dívida declarada, não palpite.
    const hunt = categoryRecords("actions").find((a) => a.name === "Hunt Prey")!;
    expect(selfEffectOf(hunt)).toBeNull();
  });

  it("doc sem effect nenhum devolve null", () => {
    expect(selfEffectOf(categoryRecords("actions").find((a) => a.name === "Climb")!)).toBeNull();
  });
});

describe.skipIf(!hasGenerated)("mentionedSelfEffect — o portão é a FICHA", () => {
  it("a postura da ficha citada na prosa dispara", () => {
    const hit = mentionedSelfEffect("Jão enters Arcane Cascade", ["Arcane Cascade"]);
    expect(hit?.slug).toBe("arcane-cascade");
  });

  it("a MESMA prosa não dispara para quem não tem a habilidade", () => {
    expect(mentionedSelfEffect("Jão enters Arcane Cascade", ["Power Attack"])).toBeNull();
    expect(mentionedSelfEffect("Jão enters Arcane Cascade", [])).toBeNull();
  });

  it("palavra comum em prosa não vira bônus para quem não tem o feat", () => {
    // "Passion" e "Flight" são nomes de feat E palavras corriqueiras. Sem o
    // portão da ficha, esta frase concederia efeito.
    expect(mentionedSelfEffect("he fights with passion and takes flight", ["Power Attack"])).toBeNull();
    // Com o feat na ficha, dispara — e aí é o comportamento correto.
    expect(mentionedSelfEffect("he fights with passion", ["Passion"])?.name).toContain("Passion");
  });

  it("prosa sem habilidade nenhuma citada não dispara", () => {
    expect(mentionedSelfEffect("Jão swings his rapier at the bandit", ["Arcane Cascade"])).toBeNull();
  });
});

describe.skipIf(!hasGenerated)("concessão pelo turno real", () => {
  it("spend_actions com a postura da ficha põe o efeito no registro", async () => {
    const c = mkCharacter({ feats: ["Arcane Cascade"] });
    const s = sessionWith(c, mk({ name: "Jão", kind: "player" }), mk({ name: "Foe", kind: "enemy" }));
    const out = await executeTool(
      s,
      "spend_actions",
      { actions: 1, reason: "Jão enters Arcane Cascade" },
      noop,
    );
    expect(s.state.effects?.map((e) => e.slug)).toEqual(["arcane-cascade"]);
    expect(out.summaryLine).toContain("Now in effect: Arcane Cascade (this encounter)");
  });

  it("repetir a postura RENOVA em vez de empilhar", async () => {
    const c = mkCharacter({ feats: ["Arcane Cascade"] });
    const s = sessionWith(c, mk({ name: "Jão", kind: "player" }), mk({ name: "Foe", kind: "enemy" }));
    await executeTool(s, "spend_actions", { actions: 1, reason: "enters Arcane Cascade" }, noop);
    const out = await executeTool(s, "spend_actions", { actions: 1, reason: "enters Arcane Cascade" }, noop);
    expect(s.state.effects).toHaveLength(1);
    expect(out.summaryLine).toContain("Renewed:");
  });

  it("sem a postura na ficha, spend_actions não concede nada", async () => {
    const s = sessionWith(
      mkCharacter({ feats: [] }),
      mk({ name: "Jão", kind: "player" }),
      mk({ name: "Foe", kind: "enemy" }),
    );
    const out = await executeTool(s, "spend_actions", { actions: 1, reason: "Jão enters Arcane Cascade" }, noop);
    // A ação foi paga: a rejeição do efeito não é rejeição da ação.
    expect(out.isError).toBeFalsy();
    expect(s.state.combat!.combatants.find((x) => x.kind === "player")!.actionsRemaining).toBe(2);
    expect(s.state.effects ?? []).toEqual([]);
  });

  it("cast_spell de buff benigno põe o efeito, com a duração real", async () => {
    const c = mkCharacter({
      spellcasting: [
        {
          name: "Divine Prepared",
          tradition: "divine",
          type: "prepared",
          ability: "wis",
          attack: 11,
          dc: 21,
          spells: ["Heroism"],
          slots: { "3": 2 },
          spellsByRank: { "3": ["Heroism"] },
        },
      ],
    });
    const s = sessionWith(c);
    const out = await executeTool(s, "cast_spell", { spell: "Heroism" }, noop);
    expect(s.state.effects?.[0]).toMatchObject({
      slug: "heroism",
      source: "Heroism",
      unit: "minutes",
      value: 10,
    });
    expect(out.summaryLine).toContain("Now in effect: Heroism (10 minutes)");
  });

  it("magia hostil não põe efeito no conjurador", async () => {
    const c = mkCharacter({
      spellcasting: [
        {
          name: "Occult Prepared",
          tradition: "occult",
          type: "prepared",
          ability: "cha",
          attack: 11,
          dc: 21,
          spells: ["Ill Omen"],
          slots: { "1": 2 },
          spellsByRank: { "1": ["Ill Omen"] },
        },
      ],
    });
    const s = sessionWith(c);
    const out = await executeTool(s, "cast_spell", { spell: "Ill Omen" }, noop);
    // A magia foi conjurada DE VERDADE (o slot saiu) — sem isso o teste passaria
    // por vacuidade, provando só que uma rejeição não concede efeito.
    expect(out.isError).toBeFalsy();
    expect(s.state.spellSlotsUsed?.["1"]).toBe(1);
    expect(s.state.effects ?? []).toEqual([]);
  });

  it("buff conjurado NUM INIMIGO não fica com o conjurador", async () => {
    const c = mkCharacter({
      spellcasting: [
        {
          name: "Divine Prepared",
          tradition: "divine",
          type: "prepared",
          ability: "wis",
          attack: 11,
          dc: 21,
          spells: ["Heroism"],
          slots: { "3": 2 },
          spellsByRank: { "3": ["Heroism"] },
        },
      ],
    });
    const s = sessionWith(c, mk({ name: "Jão", kind: "player" }), mk({ name: "Foe", kind: "enemy" }));
    const out = await executeTool(s, "cast_spell", { spell: "Heroism", target: "Foe" }, noop);
    expect(out.isError).toBeFalsy();
    expect(s.state.spellSlotsUsed?.["3"]).toBe(1);
    expect(s.state.effects ?? []).toEqual([]);
  });
});
