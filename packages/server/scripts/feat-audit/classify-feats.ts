/**
 * Classifica TODOS os feats do dataset gerado em combate × fora-de-combate e
 * atribui um arquétipo mecânico a cada um (base das baterias de teste do GM).
 *
 * Determinístico (sem LLM): traits + actionType/actionCost + PONTUAÇÃO de
 * keywords no texto (contagem de matches de cada lado; o lado com mais hits
 * vence). Precedência: traits explícitos > override de encounter > custo de
 * ação/trigger > pontuação.
 *
 * Uso: npx tsx scripts/feat-audit/classify-feats.ts
 * Saídas (data/pf2e/generated/): feats-classified.json, feats-combat.md,
 * feats-noncombat.md + resumo no stdout.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const GENERATED = join(here, "../../data/pf2e/generated");

interface FeatRecord {
  name: string;
  category: string;
  traits: string[];
  level: number | null;
  rarity: string | null;
  text: string;
  source: string;
  actionType?: string | null;
  actionCost?: number | null;
}

export type Classification = "combate" | "fora-de-combate" | "ambiguo";

export interface ClassifiedFeat {
  name: string;
  level: number | null;
  rarity: string | null;
  traits: string[];
  actionType: string | null;
  actionCost: number | null;
  classification: Classification;
  archetype: string;
}

// ---------------------------------------------------------------------------
// Sinais
// ---------------------------------------------------------------------------

const NONCOMBAT_TRAITS = new Set(["downtime", "exploration"]);
const COMBAT_TRAITS = new Set([
  "stance",
  "flourish",
  "press",
  "open",
  "attack",
  "rage",
  "impulse",
]);

/** Mecânica que só existe em encounter mode. */
const COMBAT_KW =
  /\b(Strikes?|Striking|attack rolls?|weapon damage|deals? [^.]{0,20}damage|persistent damage|off-guard|flat-footed|your AC|to (your )?AC|AC against|saving throws?|(Reflex|Fortitude|Will) (save|DC)|initiative|multiple attack penalty|critical (hit|specialization|success on [^.]*Strike)|unarmed attacks?|Grapple|Trip\b|Shove|Disarm|Demoralize|Feint|Tumble Through|Raise a Shield|Shield Block|Hit Points?|recovery checks?|dying|wounded|doomed|resistance (to|\d)|weakness \d|flanki?n?g?|damage (die|dice)|spell attack|spell DC|Cast a Spell [^.]*combat)\b/gi;

/** Mecânica de exploração, social e downtime. */
const NONCOMBAT_KW =
  /\b(Earn Income|Crafting|Craft\b|Make an Impression|Gather Information|Track(ing)?\b|Repair|Identify Magic|Decipher Writing|Learn a Spell|Create Forgery|Subsist|Recall Knowledge|Diplomacy|Society|Performance?\b|Lore\b|languages?\b|trained in|expert in|master in|legendary in|downtime|exploration|travel(ing)?|Sense Motive|Request\b|attitude|conversation|difficult terrain|Avoid Notice|Treat Wounds|Investigate|Coerce|merchant|purchase|Perception check to (Seek|notice)|Search\b|Survey|camp(ing)?|forage)\b/gi;

/** Frases que amarram o feat ao encounter mode mesmo com cara de skill. */
const ENCOUNTER_OVERRIDE_KW =
  /\b(in combat|during an encounter|in an encounter|while in combat|until the (start|end) of your next turn|(start|end) of (your|its|their|each) turn|your turns?\b|when you roll initiative)\b/i;

const COMBAT_TRIGGER_KW =
  /trigger[^.]*\b(Strikes?|attacks?|damag\w*|hit|crit\w*|miss(es)?|save|moves?|targeted|adjacent|drops? to 0|reduced to 0|Casts? a Spell)\b/i;

const CONDITION_KW =
  /\b(off-guard|flat-footed|frightened|grabbed|prone|stunned|slowed|sickened|clumsy|enfeebled|stupefied|fascinated|immobilized|blinded|dazzled|deafened|fatigued|drained|paralyzed)\b/i;

function hits(text: string, re: RegExp): number {
  return (text.match(re) ?? []).length;
}

// ---------------------------------------------------------------------------
// Arquétipos mecânicos (primeiro match vence, dentro da classificação)
// ---------------------------------------------------------------------------

function combatArchetype(f: FeatRecord): string {
  const t = f.text;
  const traits = new Set(f.traits);
  if (traits.has("spellshape") || traits.has("metamagic")) return "magia (fora de escopo)";
  if (
    /\b(spells?|cantrips?|focus point|spellcasting|ritual)\b/i.test(t) &&
    !/\bStrike\b/.test(t)
  ) {
    return "magia (fora de escopo)";
  }
  if (traits.has("stance")) return "stance";
  const grantsReaction = /\bgains? the [^.]*reaction\b|\bas a reaction\b/i.test(t);
  if (f.actionType === "reaction" || f.actionType === "free" || grantsReaction) {
    return /\bStrike\b/.test(t) ? "reacao-ofensiva" : "reacao-defensiva";
  }
  if (/\b(two|both|second) Strikes?\b/i.test(t) || /Strike twice/i.test(t)) {
    return "atividade-multi-strike";
  }
  if (/\b(make|attempt) (a|one|an) [^.]*Strike\b/i.test(t)) {
    if (/\bStride|Step\b|Leap|move up to|your Speed\b/i.test(t)) return "movimento-tatico";
    return "strike-modificada";
  }
  if (
    CONDITION_KW.test(t) &&
    /\b(attempt|roll) [^.]*(check|save)|against [^.]*(Will|Fortitude|Reflex) DC/i.test(t)
  ) {
    return "condicao-via-check";
  }
  if (/\bStride|Step\b|Leap|move up to|your Speed\b/i.test(t) && (f.actionCost ?? 0) >= 1) {
    return "movimento-tatico";
  }
  if (f.actionType === "action" && /\b(ally|allies)\b/i.test(t)) return "buff-suporte";
  if (f.actionType === "action" && /\b(Hit Points?|heal)/i.test(t)) return "buff-suporte";
  if (!f.actionType || f.actionType === "passive") return "passivo-combate";
  return "combate-outro";
}

function noncombatArchetype(f: FeatRecord): string {
  const t = f.text;
  const traits = new Set(f.traits);
  if (traits.has("downtime")) return "downtime";
  if (traits.has("exploration")) return "exploracao";
  if (/\b(Earn Income|Craft\b|Crafting|Create Forgery|Repair)\b/i.test(t) && f.actionType !== "passive") {
    return "downtime";
  }
  if (/\b(Diplomacy|Make an Impression|attitude|Request|conversation|Perform\b|Coerce)\b/i.test(t)) {
    return "social-influencia";
  }
  if (/\b(travel|Avoid Notice|difficult terrain|forage|camp|Track)\b/i.test(t)) {
    return "exploracao";
  }
  if (f.actionType === "action" || f.actionType === "reaction" || f.actionType === "free") {
    return "skill-activity";
  }
  return "passivo-utilitario";
}

export function classify(f: FeatRecord): ClassifiedFeat {
  const text = f.text;
  let classification: Classification | null = null;

  const hasNoncombatTrait = f.traits.some((t) => NONCOMBAT_TRAITS.has(t));
  const hasCombatTrait = f.traits.some((t) => COMBAT_TRAITS.has(t));
  const isReactionLike = f.actionType === "reaction" || f.actionType === "free";

  // 1. Traits explícitos.
  if (hasNoncombatTrait && !hasCombatTrait) classification = "fora-de-combate";
  else if (hasCombatTrait) classification = "combate";
  // 2. Override de encounter ("even in combat", "until your next turn"...).
  else if (ENCOUNTER_OVERRIDE_KW.test(text)) classification = "combate";
  // 3. Reação/free com trigger de combate.
  else if (isReactionLike && COMBAT_TRIGGER_KW.test(text)) classification = "combate";

  // 4. Pontuação de keywords (decide o resto).
  if (!classification) {
    const c = hits(text, COMBAT_KW);
    const n = hits(text, NONCOMBAT_KW);
    const isSpellcasting =
      /\b(spells?|cantrips?|focus point|spellcasting|ritual)\b/i.test(text) ||
      f.traits.includes("spellshape") ||
      f.traits.includes("metamagic");
    if (c === 0 && n === 0) {
      // Sem sinal nenhum: conjuração vira "magia" (precisa de caster; fora do
      // escopo da bateria v1); sentidos são utilidade de exploração; Speeds
      // novas são movimento (encontro). O resto fica ambíguo (revisão manual —
      // majoritariamente "encanamento" de build: feat que dá outro feat etc.).
      if (isSpellcasting) classification = "combate";
      else if (/\b(darkvision|low-light vision|scent|tremorsense|echolocation)\b/i.test(text)) {
        classification = "fora-de-combate";
      } else if (/\b(fly|climb|swim|burrow) Speed\b|\bYou Fly\b/i.test(text)) {
        classification = "combate";
      } else classification = "ambiguo";
    } else if (c > n) {
      classification = "combate";
    } else if (n > c) {
      classification = "fora-de-combate";
    } else if (/\b(foe|enemy|opponent)\b/i.test(text) || /against [^.]*(Will|Fortitude|Reflex) DC/i.test(text)) {
      // Empate, mas o alvo é um inimigo (Bon Mot & cia): é ação de combate.
      classification = "combate";
    } else {
      // Empate restante: feats de skill pendem para fora.
      classification = f.traits.includes("skill") ? "fora-de-combate" : "combate";
    }
  }

  const archetype =
    classification === "combate"
      ? combatArchetype(f)
      : classification === "fora-de-combate"
        ? noncombatArchetype(f)
        : "ambiguo";

  return {
    name: f.name,
    level: f.level,
    rarity: f.rarity,
    traits: f.traits,
    actionType: f.actionType ?? null,
    actionCost: f.actionCost ?? null,
    classification,
    archetype,
  };
}

// ---------------------------------------------------------------------------
// Amostra de validação (nomes do remaster) e a classificação esperada.
// ---------------------------------------------------------------------------

const VALIDATION: Record<string, Classification> = {
  "Twin Feint": "combate",
  "Double Slice": "combate",
  "Vicious Swing": "combate",
  "Sudden Charge": "combate",
  "Reactive Shield": "combate",
  "Nimble Dodge": "combate",
  "Reactive Strike": "combate",
  "Mountain Stance": "combate",
  "Goblin Scuttle": "combate",
  "Dirty Trick": "combate",
  "Distracting Feint": "combate",
  "Twin Distraction": "combate",
  Kneecap: "combate",
  "Incredible Initiative": "combate",
  Toughness: "combate",
  "Battle Medicine": "combate",
  "Bon Mot": "combate",
  Diehard: "combate",
  "Shield Block": "combate",
  "Intimidating Glare": "combate",
  "Sow Rumor": "fora-de-combate",
  "Charming Liar": "fora-de-combate",
  "Lie to Me": "fora-de-combate",
  "Secret Speech": "fora-de-combate",
  Multilingual: "fora-de-combate",
  Hobnobber: "fora-de-combate",
  "Terrain Stalker": "fora-de-combate",
  Forager: "fora-de-combate",
  "Group Impression": "fora-de-combate",
  "Experienced Tracker": "fora-de-combate",
  "Specialty Crafting": "fora-de-combate",
  Streetwise: "fora-de-combate",
};

// ---------------------------------------------------------------------------
// Saídas
// ---------------------------------------------------------------------------

function mdTable(feats: ClassifiedFeat[], title: string): string {
  const byArch = new Map<string, ClassifiedFeat[]>();
  for (const f of feats) {
    const list = byArch.get(f.archetype) ?? [];
    list.push(f);
    byArch.set(f.archetype, list);
  }
  const parts = [`# ${title}`, "", `Total: ${feats.length} feats.`, ""];
  for (const [arch, list] of [...byArch.entries()].sort((a, b) => b[1].length - a[1].length)) {
    list.sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || a.name.localeCompare(b.name));
    parts.push(`## ${arch} (${list.length})`, "");
    parts.push("| Feat | Nível | Custo | Traits |");
    parts.push("|---|---|---|---|");
    for (const f of list) {
      const cost =
        f.actionType === "action"
          ? `${f.actionCost ?? "?"}a`
          : (f.actionType ?? "passivo");
      parts.push(
        `| ${f.name} | ${f.level ?? "—"} | ${cost} | ${f.traits.join(", ") || "—"} |`,
      );
    }
    parts.push("");
  }
  return parts.join("\n");
}

function main() {
  const feats = (
    JSON.parse(readFileSync(join(GENERATED, "feats.json"), "utf8")) as FeatRecord[]
  ).filter((f) => f.category === "feats");

  const classified = feats.map(classify);

  const combat = classified.filter((f) => f.classification === "combate");
  const noncombat = classified.filter((f) => f.classification === "fora-de-combate");
  const ambiguous = classified.filter((f) => f.classification === "ambiguo");

  // FORA de generated/: qualquer .json ali entra no índice do lookup_rule.
  writeFileSync(
    join(here, "feats-classified.json"),
    JSON.stringify(classified, null, 1),
  );
  writeFileSync(join(GENERATED, "feats-combat.md"), mdTable(combat, "Feats de COMBATE"));
  writeFileSync(
    join(GENERATED, "feats-noncombat.md"),
    mdTable(noncombat, "Feats FORA DE COMBATE"),
  );

  console.log(`Total: ${classified.length}`);
  console.log(`  combate:         ${combat.length}`);
  console.log(`  fora-de-combate: ${noncombat.length}`);
  console.log(`  ambíguo:         ${ambiguous.length} (${((ambiguous.length / classified.length) * 100).toFixed(1)}%)`);

  const counts = (list: ClassifiedFeat[]) => {
    const m = new Map<string, number>();
    for (const f of list) m.set(f.archetype, (m.get(f.archetype) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  };
  console.log("\nArquétipos (combate):");
  for (const [a, n] of counts(combat)) console.log(`  ${a}: ${n}`);
  console.log("Arquétipos (fora):");
  for (const [a, n] of counts(noncombat)) console.log(`  ${a}: ${n}`);

  console.log("\nValidação da amostra:");
  const byName = new Map(classified.map((f) => [f.name, f]));
  let bad = 0;
  for (const [name, expected] of Object.entries(VALIDATION)) {
    const got = byName.get(name);
    if (!got) {
      console.log(`  ?? ${name}: NÃO ENCONTRADO no dataset`);
      bad++;
    } else if (got.classification !== expected) {
      console.log(
        `  XX ${name}: esperado ${expected}, veio ${got.classification} (arquétipo ${got.archetype}, actionType ${got.actionType})`,
      );
      bad++;
    }
  }
  console.log(
    bad === 0
      ? `  OK — todos os ${Object.keys(VALIDATION).length} bateram.`
      : `  ${bad} divergência(s) de ${Object.keys(VALIDATION).length}.`,
  );
}

main();
