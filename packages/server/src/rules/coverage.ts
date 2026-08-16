/**
 * Auditoria de cobertura de uma FICHA: o que a engine executa, o que ela
 * declara não executar, e o que ela ignora em silêncio.
 *
 * POR QUE ESTE ARQUIVO EXISTE. Medido em 2026-08-15 sobre o dataset: dos 7.039
 * feats do PF2e, só 42,6% carregam rule elements — 60% dos feats de CLASSE e
 * 74% dos de PERÍCIA não têm mecânica legível por máquina em fonte nenhuma
 * (nem aqui, nem no Foundry, que mostra o texto a um GM humano). Ou seja: o
 * teto do projeto não é "importar melhor", é **saber o que sabe**. Sem esta
 * medição, cada personagem novo parecia trazer bugs novos, quando o que ele
 * trazia era a fronteira do implementado, invisível.
 *
 * A auditoria é ESTÁTICA por necessidade, não por gosto: `ToolOutcome` não tem
 * campo de "mecanizei", então sucesso mecânico e prosa saem indistinguíveis do
 * runtime. Aqui replicamos os portões chamando as mesmas funções puras que a
 * engine usa — inclusive `actorModifiersFor`, cujo canal `.skipped` o runtime
 * calcula e joga fora nos quatro call sites de produção.
 *
 * Os três baldes, e a fronteira entre eles:
 *  - MECANIZADO — a engine aplica. Rule element com leitor que sobrevive aos
 *    portões, efeito concedível, magia com dano/save/ataque, Sneak Attack.
 *  - DECLARADO — a engine viu, decidiu não aplicar, e SABE POR QUÊ (`skipped`
 *    com razão tipada). Honesto: dá para contar ao jogador.
 *  - CEGO — a engine não aplica e não avisa. É o balde que importa: silêncio.
 *    Feat de prosa pura mora aqui, e é daqui que a Fase de declaração (T5)
 *    tira coisas para o balde DECLARADO.
 */
import type { Character } from "@pf2e/shared";
import {
  categoryRecords,
  costProfileOf,
  lookupInCategory,
  spellRecord,
  type RuleRecord,
} from "./dataset.js";
import { selfEffectOf } from "./active-effects.js";
import { grantedDocsFor } from "./granted.js";
import { actorModifiersFor, type SkipReason } from "./actor-modifiers.js";

/** As 4 keys de rule element de 38 que têm leitor (ver [T5] na conformance). */
export const CONSUMED_KEYS = new Set([
  "FlatModifier",
  "Resistance",
  "Weakness",
  "Immunity",
]);

/** Categorias cujos rule elements a engine abre para a ficha. */
const SHEET_CATEGORIES = ["feats", "classes", "heritages", "ancestries", "backgrounds"] as const;

export type CoverageVerdict = "mechanized" | "declared" | "blind";

export type EntryKind =
  | "feat"
  | "classFeature"
  | "ancestry"
  | "heritage"
  | "background"
  | "class"
  | "spell"
  | "weapon"
  | "item";

export interface CoverageEntry {
  name: string;
  kind: EntryKind;
  verdict: CoverageVerdict;
  /** A razão É o produto: um veredito sem porquê não serve nem a teste nem a jogador. */
  reason: string;
  /** Keys de rule element do doc, quando ele tem — inclusive as sem leitor. */
  ruleKeys?: string[];
  skipReason?: SkipReason;
}

export interface CoverageReport {
  entries: CoverageEntry[];
  counts: Record<CoverageVerdict, number>;
  /** Fração mecanizada, para a linha de métrica. */
  mechanizedRatio: number;
}

/** Categoria do dataset onde cada tipo de entrada de ficha mora. */
const CATEGORY_OF: Partial<Record<EntryKind, string>> = {
  feat: "feats",
  classFeature: "feats",
  ancestry: "ancestries",
  heritage: "heritages",
  background: "backgrounds",
  class: "classes",
};

function ruleKeysOf(rec: RuleRecord): string[] {
  return [...new Set((rec.rules ?? []).map((r) => String((r as { key?: unknown }).key ?? "")))].filter(
    Boolean,
  );
}

/**
 * Acha o doc de uma entrada de ficha. Procura na categoria natural primeiro e
 * só então nas demais de ficha — o mesmo espírito do portão do ADR-010, sem
 * fuzzy: nome que não casa EXATO é achado da auditoria, não coisa a adivinhar.
 */
function recordFor(name: string, kind: EntryKind, category?: string): RuleRecord | null {
  // `category` vem de quem JÁ sabe onde o doc mora — hoje as concessões de
  // `GrantItem`, que resolveram por uuid. Sem isto, uma AÇÃO concedida era
  // procurada só nas categorias de ficha (`actions` não está entre elas) e a
  // auditoria a reportava como "nome não casa nenhum doc do dataset", que é
  // falso e inflava o balde cego em 53 entradas.
  if (category) {
    const hit = lookupInCategory(name, category);
    if (hit) return hit;
  }
  const primary = CATEGORY_OF[kind];
  if (primary) {
    const hit = lookupInCategory(name, primary);
    if (hit) return hit;
  }
  for (const cat of SHEET_CATEGORIES) {
    if (cat === primary) continue;
    const hit = lookupInCategory(name, cat);
    if (hit) return hit;
  }
  return null;
}

/** Sneak Attack é a ÚNICA feature de classe com código próprio (agent.ts). */
const HARDCODED_FEATURES = /sneak attack/i;

function auditNamed(
  c: Character,
  name: string,
  kind: EntryKind,
  category?: string,
): CoverageEntry {
  if (HARDCODED_FEATURES.test(name)) {
    return { name, kind, verdict: "mechanized", reason: "implemented in code (Sneak Attack)" };
  }

  const rec = recordFor(name, kind, category);
  if (!rec) {
    return {
      name,
      kind,
      verdict: "blind",
      reason: "name matches no dataset doc — the engine does not know it exists",
    };
  }

  // Concessão de efeito (stance, selfEffect, Effect: homônimo) é mecanização
  // real: o efeito entra no registro e seus rule elements passam a valer.
  if (selfEffectOf(rec)) {
    return { name, kind, verdict: "mechanized", reason: "grants an active effect with the duration from the data" };
  }

  const keys = ruleKeysOf(rec);
  if (keys.length === 0) {
    const cost = costProfileOf(name, kind === "feat" ? "feats" : "actions");
    return {
      name,
      kind,
      verdict: "blind",
      reason: cost
        ? `plain prose: the engine charges the cost (${cost.kind}) but nothing applies the effect`
        : "plain prose: no machine-readable mechanics, here or in any source",
    };
  }

  const readable = keys.filter((k) => CONSUMED_KEYS.has(k));
  if (readable.length === 0) {
    return {
      name,
      kind,
      verdict: "blind",
      reason: `has mechanics in the data that no reader opens (${keys.join(", ")})`,
      ruleKeys: keys,
    };
  }

  // Tem key com leitor: o veredito depende dos portões. `skipped` é o canal
  // honesto — a engine sabe por que não aplicou.
  const skip = skipOf(c, name);
  if (skip) {
    return {
      name,
      kind,
      verdict: "declared",
      reason: `the engine saw it and did not apply it (${skip})`,
      ruleKeys: keys,
      skipReason: skip,
    };
  }
  return {
    name,
    kind,
    verdict: "mechanized",
    reason: `rule element with a reader (${readable.join(", ")})`,
    ruleKeys: keys,
  };
}

/**
 * O motivo de skip de um doc, se ele aparecer em `skipped` em algum seletor.
 *
 * Sem contexto de rolagem (`ro`), todo predicado fica indecidível — que é
 * exatamente o estado do runtime em quatro dos call sites. Varremos os
 * seletores mais comuns; a ausência de skip significa que existe cena em que o
 * modificador entra.
 */
const PROBE_SELECTORS = [
  "ac",
  "attack",
  "damage",
  "initiative",
  "perception",
  "saving-throw",
  "skill-check",
];

function skipOf(c: Character, source: string): SkipReason | null {
  const key = source.toLowerCase().trim();
  let seen: SkipReason | null = null;
  for (const selector of PROBE_SELECTORS) {
    const { applied, skipped } = actorModifiersFor(c, selector);
    if (applied.some((m) => m.source?.toLowerCase().trim() === key)) return null;
    const hit = skipped.find((s) => s.source.toLowerCase().trim() === key);
    if (hit && !seen) seen = hit.reason;
  }
  return seen;
}

function auditSpell(name: string): CoverageEntry {
  const rec = spellRecord(name);
  if (!rec) {
    return {
      name,
      kind: "spell",
      verdict: "blind",
      reason: "spell not found in the dataset — cast_spell resolves nothing",
    };
  }
  const mech = rec.spell;
  if (!mech) {
    return { name, kind: "spell", verdict: "blind", reason: "no structured mechanics block" };
  }
  if (mech.damage?.length || mech.attack || mech.defense?.save) {
    return {
      name,
      kind: "spell",
      verdict: "mechanized",
      reason: "structured damage/attack/save — cast_spell resolves it in code",
    };
  }
  // O caso de utilidade tem string sentinela no runtime ("No structured combat
  // effect"), então a engine ao menos DIZ ao narrador que não resolveu.
  return {
    name,
    kind: "spell",
    verdict: "declared",
    reason: "utility: no damage/save/attack — the engine declares the void to the narrator",
  };
}

/**
 * Audita a ficha inteira.
 *
 * Não recebe contexto de rolagem de propósito: a pergunta é "o que esta FICHA
 * tem que a engine sabe executar", não "o que incide nesta cena".
 */
export function auditCharacter(c: Character): CoverageReport {
  const entries: CoverageEntry[] = [];

  for (const name of c.feats ?? []) entries.push(auditNamed(c, name, "feat"));
  // Concedidos (`GrantItem`): entram como entrada PRÓPRIA porque trazem a
  // própria mecânica. Antes de existirem aqui, o feat que concede aparecia
  // como cego ("mecânica que nenhum leitor abre") e o que ele concedia não
  // aparecia de forma alguma — a ficha era medida menor do que é.
  for (const g of grantedDocsFor(c)) {
    entries.push(auditNamed(c, g.name, "feat", g.category));
  }
  for (const name of c.classFeatures ?? []) entries.push(auditNamed(c, name, "classFeature"));
  if (c.heritage) entries.push(auditNamed(c, c.heritage, "heritage"));
  if (c.ancestry) entries.push(auditNamed(c, c.ancestry, "ancestry"));
  if (c.background) entries.push(auditNamed(c, c.background, "background"));

  for (const entry of c.spellcasting ?? []) {
    for (const spell of entry.spells ?? []) entries.push(auditSpell(spell));
  }

  // Armas: o Strike é resolvido em código de ponta a ponta (bônus da ficha,
  // MAP, CA efetiva, dano tipado). É a parte mais sólida do sistema.
  for (const w of c.weapons ?? []) {
    entries.push({
      name: w.name,
      kind: "weapon",
      verdict: "mechanized",
      reason: "Strike resolved in code (attack, MAP, typed damage)",
    });
  }

  const counts: Record<CoverageVerdict, number> = { mechanized: 0, declared: 0, blind: 0 };
  for (const e of entries) counts[e.verdict]++;
  const total = entries.length || 1;
  return { entries, counts, mechanizedRatio: counts.mechanized / total };
}

/**
 * A habilidade da FICHA citada num texto e o que a engine faz com ela.
 *
 * É a ponte da T5: o que a auditoria classifica offline vira, em jogo, uma
 * declaração ao narrador e ao jogador. Sem isto, invocar Toughness e invocar
 * Sneak Attack produzem exatamente a mesma linha de resumo — e o jogador não
 * tem como saber que uma foi enforced e a outra foi narrada por cima.
 *
 * Devolve `null` quando nada da ficha é citado OU quando o que foi citado é
 * MECANIZADO: declarar o que funciona seria ruído.
 */
export function adjudicationFor(
  c: Character,
  text: string,
  owned: readonly string[],
): { name: string; reason: string } | null {
  const t = text.toLowerCase();
  for (const name of owned) {
    const key = name.toLowerCase().trim();
    // Nomes curtos casam demais em prosa livre (o mesmo piso que
    // `mentionedSelfEffect` usa).
    if (key.length < 6) continue;
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`\\b${escaped}\\b`).test(t)) continue;
    const kind: EntryKind = (c.feats ?? []).includes(name) ? "feat" : "classFeature";
    const entry = auditNamed(c, name, kind);
    if (entry.verdict === "mechanized") return null;
    return { name, reason: entry.reason };
  }
  return null;
}

/**
 * A magia citada e o que a engine faz com ela — o par de `adjudicationFor`
 * para `cast_spell`.
 *
 * Magia não está em `ownedAbilities` (que é feats + classFeatures), então o
 * caminho de conjuração precisa do seu próprio: 51% das magias não têm dano,
 * save nem ataque, e para essas `cast_spell` cobra o slot e devolve prosa.
 */
export function adjudicationForSpell(name: string): { name: string; reason: string } | null {
  const entry = auditSpell(name);
  if (entry.verdict === "mechanized") return null;
  return { name: entry.name, reason: entry.reason };
}

/** Conta, no dataset inteiro, quantos docs de ficha caem em cada balde. */
export function datasetCoverageCensus(): Record<string, { total: number; withReader: number }> {
  const out: Record<string, { total: number; withReader: number }> = {};
  for (const cat of SHEET_CATEGORIES) {
    let total = 0;
    let withReader = 0;
    for (const rec of categoryRecords(cat)) {
      total++;
      const keys = ruleKeysOf(rec);
      if (keys.some((k) => CONSUMED_KEYS.has(k)) || selfEffectOf(rec)) withReader++;
    }
    out[cat] = { total, withReader };
  }
  return out;
}
