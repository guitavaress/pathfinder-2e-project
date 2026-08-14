/**
 * O registro de efeitos ativos (Fase 2.6 / T6.1).
 *
 * Os casos usam effects REAIS do dataset, com a duração que o pf2e publica. O
 * que mais importa aqui é o prazo: um efeito que não expira é pior do que um
 * efeito que não existe — vira bônus permanente inventado.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ActiveEffect } from "@pf2e/shared";
import {
  anchorToRound,
  effectLabel,
  effectSlugAliases,
  effectSlugOf,
  expireEffects,
  expiryRound,
  grantEffect,
  removeEffect,
  resolveEffect,
} from "./active-effects.js";

const here = dirname(fileURLToPath(import.meta.url));
const hasGenerated = existsSync(join(here, "../../data/pf2e/generated"));

/** Uma entrada de registro sem passar pelo dado — para os testes de expiração. */
function entry(over: Partial<ActiveEffect> = {}): ActiveEffect {
  return {
    slug: "heroism",
    name: "Spell Effect: Heroism",
    source: "Heroism",
    unit: "rounds",
    value: 1,
    expiresOnRound: null,
    ...over,
  };
}

describe("effectSlugOf — o slug que o predicado casa", () => {
  it("tira o prefixo de compêndio, que não é parte da identidade", () => {
    expect(effectSlugOf("Effect: Rage")).toBe("rage");
    expect(effectSlugOf("Spell Effect: Heroism")).toBe("heroism");
    // 86 effects usam "Stance:" — é onde vive o Arcane Cascade, um dos slugs
    // que aparecem nos predicados indecidíveis medidos na Fase 2.5.
    expect(effectSlugOf("Stance: Arcane Cascade")).toBe("arcane-cascade");
    expect(effectSlugOf("Aura: Righteous Call")).toBe("righteous-call");
  });

  it("não mutila nome sem prefixo de compêndio", () => {
    expect(effectSlugOf("Kinetic Aura")).toBe("kinetic-aura");
    // "Rage" não é prefixo conhecido: nada é removido.
    expect(effectSlugOf("Rage: The Reckoning")).toBe("rage-the-reckoning");
  });

  it("o nome COM prefixo continua sendo um alias válido", () => {
    expect(effectSlugAliases("Stance: Arcane Cascade")).toEqual([
      "arcane-cascade",
      "stance-arcane-cascade",
    ]);
    expect(effectSlugAliases("Kinetic Aura")).toEqual(["kinetic-aura"]);
  });
});

describe("expiryRound — prazo em rodadas", () => {
  it("fora de combate não há relógio: prazo nenhum é inventado", () => {
    expect(expiryRound("rounds", 1, null)).toBeNull();
    expect(expiryRound("minutes", 10, null)).toBeNull();
  });

  it("1 rodada concedida na rodada 3 sai no fim da rodada 3", () => {
    // O tick roda no FIM da rodada, que é onde o `turn-start` do pf2e cai neste
    // engine de "uma mensagem = uma rodada".
    expect(expiryRound("rounds", 1, 3)).toBe(3);
  });

  it("`rounds: 0` (até o fim deste turno) não vira rodada negativa", () => {
    expect(expiryRound("rounds", 0, 1)).toBe(1);
  });

  it("minuto vira rodada por conversão RAW, não por chute", () => {
    // 1 minuto = 10 rodadas. Concedido na rodada 1, cobre até a 10.
    expect(expiryRound("minutes", 1, 1)).toBe(10);
    expect(expiryRound("minutes", 10, 1)).toBe(100);
  });

  it("hora, dia, encontro e sem-prazo não têm prazo em rodada", () => {
    expect(expiryRound("hours", 1, 5)).toBeNull();
    expect(expiryRound("days", 1, 5)).toBeNull();
    expect(expiryRound("encounter", -1, 5)).toBeNull();
    expect(expiryRound("unlimited", -1, 5)).toBeNull();
  });
});

describe("expireEffects — os três limites de tempo que a engine tem", () => {
  it("fim de rodada: sai o que venceu, fica o que não", () => {
    const list = [
      entry({ slug: "a", expiresOnRound: 3 }),
      entry({ slug: "b", expiresOnRound: 5 }),
    ];
    const { effects, expired } = expireEffects(list, "round", 3);
    expect(expired.map((e) => e.slug)).toEqual(["a"]);
    expect(effects.map((e) => e.slug)).toEqual(["b"]);
  });

  it("sem prazo em rodada, o tick de rodada não tira nada", () => {
    const list = [entry({ unit: "hours", value: 1, expiresOnRound: null })];
    expect(expireEffects(list, "round", 99).expired).toEqual([]);
  });

  it("fim de combate: sai o que não sobrevive à luta por definição", () => {
    // `encounter` dura o encontro; `rounds` tem prazo menor que qualquer luta.
    // O resto atravessa — o relógio de minutos/horas é o descanso, porque fora
    // de combate esta engine não tem relógio nenhum.
    const list = [
      entry({ slug: "enc", unit: "encounter", value: -1 }),
      entry({ slug: "rnd", unit: "rounds", value: 1 }),
      entry({ slug: "min", unit: "minutes", value: 1 }),
      entry({ slug: "hr", unit: "hours", value: 1 }),
      entry({ slug: "perm", unit: "unlimited", value: -1 }),
    ];
    const { effects, expired } = expireEffects(list, "combat-end");
    expect(expired.map((e) => e.slug).sort()).toEqual(["enc", "rnd"]);
    expect(effects.map((e) => e.slug).sort()).toEqual(["hr", "min", "perm"]);
  });

  it("buff de MINUTOS sobrevive à luta — a luta dura ~1 minuto", () => {
    // Heroism são 10 minutos e custa um slot de círculo 3. Uma luta típica dura
    // ~10 rodadas = 1 minuto. Matar o efeito no fim do combate destrói um
    // recurso que o jogador pagou, e é o pior dos dois erros possíveis aqui:
    // expirar cedo demais tira algo comprado; expirar tarde demais é limitado
    // pelo descanso.
    const list = [entry({ slug: "hero", unit: "minutes", value: 10, expiresOnRound: 100 })];
    expect(expireEffects(list, "combat-end").expired).toEqual([]);
  });

  it("o prazo em rodadas NÃO atravessa para a próxima luta", () => {
    // A numeração de rodadas recomeça em 1 a cada combate. Um prazo calculado na
    // luta A (rodada 100) comparado contra a rodada 3 da luta B nunca vence — o
    // efeito viveria para sempre. Quem sobrevive à luta perde o relógio e é
    // reancorado na próxima.
    const list = [entry({ slug: "hero", unit: "minutes", value: 10, expiresOnRound: 100 })];
    const { effects } = expireEffects(list, "combat-end");
    expect(effects[0]!.expiresOnRound).toBeNull();
    // E aí a próxima luta lhe dá prazo de novo.
    expect(anchorToRound(effects, 1)[0]!.expiresOnRound).toBe(100);
  });

  it("descanso: só o sem-prazo atravessa a noite", () => {
    const list = [
      entry({ slug: "hr", unit: "hours", value: 8 }),
      entry({ slug: "day", unit: "days", value: 1 }),
      entry({ slug: "perm", unit: "unlimited", value: -1 }),
    ];
    const { effects, expired } = expireEffects(list, "rest");
    expect(expired.map((e) => e.slug).sort()).toEqual(["day", "hr"]);
    expect(effects.map((e) => e.slug)).toEqual(["perm"]);
  });

  it("efeito sem prazo NUNCA sai por tempo — só por remoção explícita", () => {
    const perm = [entry({ unit: "unlimited", value: -1, expiresOnRound: null })];
    for (const ev of ["round", "combat-end", "rest"] as const) {
      expect(expireEffects(perm, ev, 999).expired).toEqual([]);
    }
    expect(removeEffect(perm, "Spell Effect: Heroism").removed?.slug).toBe("heroism");
  });

  it("expirar não muta a lista de entrada", () => {
    const list = [entry({ expiresOnRound: 1 })];
    expireEffects(list, "round", 9);
    expect(list).toHaveLength(1);
  });
});

describe("anchorToRound — entrar em combate dá relógio ao que não tinha", () => {
  it("o efeito pego na exploração ganha prazo ao começar a luta", () => {
    // Sem isso, um efeito de 1 rodada concedido fora de combate duraria a luta
    // inteira: teria `expiresOnRound` null e nenhum tick o alcançaria.
    const list = [entry({ unit: "rounds", value: 1, expiresOnRound: null })];
    expect(anchorToRound(list, 1)[0]!.expiresOnRound).toBe(1);
  });

  it("quem já tinha prazo não é reancorado", () => {
    const list = [entry({ unit: "rounds", value: 1, expiresOnRound: 2 })];
    expect(anchorToRound(list, 7)[0]!.expiresOnRound).toBe(2);
  });
});

describe.skipIf(!hasGenerated)("resolveEffect e grantEffect — contra o dado real", () => {
  it("lê nome, slug e duração estruturada do doc", () => {
    const r = resolveEffect("Spell Effect: Heroism");
    expect(r).toMatchObject({
      name: "Spell Effect: Heroism",
      slug: "heroism",
      unit: "minutes",
      value: 10,
    });
  });

  it("stance com duração de encontro vem como encontro", () => {
    expect(resolveEffect("Stance: Arcane Cascade")).toMatchObject({
      slug: "arcane-cascade",
      unit: "encounter",
      value: -1,
    });
  });

  it("efeito que o dado não conhece é REJEITADO, não inventado", () => {
    expect(resolveEffect("Effect: Bênção do Dragão Interior")).toBeNull();
    const { effects, granted, rejected } = grantEffect([], "Effect: Bênção do Dragão Interior", "?");
    expect(effects).toEqual([]);
    expect(granted).toBeNull();
    expect(rejected).toContain("no effect named");
  });

  it("conceder em combate já calcula o prazo em rodadas", () => {
    const { granted } = grantEffect([], "Spell Effect: Heroism", "Heroism", 2);
    // 10 minutos = 100 rodadas: na prática, o resto da luta.
    expect(granted).toMatchObject({ slug: "heroism", source: "Heroism", expiresOnRound: 101 });
  });

  it("reaplicar REPÕE a duração em vez de empilhar", () => {
    const first = grantEffect([], "Spell Effect: Heroism", "Heroism", 1);
    const again = grantEffect(first.effects, "Spell Effect: Heroism", "Heroism", 5);
    expect(again.effects).toHaveLength(1);
    expect(again.refreshed).toBe(true);
    expect(again.effects[0]!.expiresOnRound).toBe(104);
  });

  it("dois efeitos diferentes convivem", () => {
    const a = grantEffect([], "Spell Effect: Heroism", "Heroism", 1);
    const b = grantEffect(a.effects, "Stance: Arcane Cascade", "Arcane Cascade", 1);
    expect(b.effects.map((e) => e.slug).sort()).toEqual(["arcane-cascade", "heroism"]);
  });

  it("a etiqueta do resumo mecânico não vaza o prefixo do compêndio", () => {
    const { granted } = grantEffect([], "Spell Effect: Heroism", "Heroism", 1);
    expect(effectLabel(granted!)).toBe("Heroism (10 minutes)");
    const { granted: stance } = grantEffect([], "Stance: Arcane Cascade", "Arcane Cascade", 1);
    expect(effectLabel(stance!)).toBe("Arcane Cascade (this encounter)");
  });
});
