/**
 * Seleciona a BATERIA de teste: 4-5 feats representativos por arquétipo
 * mecânico, a partir de feats-classified.json. Bugs do GM moram no arquétipo
 * (como a engine/modelo lidam com o TIPO de mecânica), não no feat individual.
 *
 * Prioridade: (a) feats do personagem-exemplo (Jão, Rogue 5 goblin) — já têm
 * comportamento conhecido dos play-tests; (b) core comuns de nível ≤6;
 * (c) diversidade de classe dentro do arquétipo.
 *
 * Uso: npx tsx scripts/feat-audit/select-battery.ts
 * Saída: scripts/feat-audit/battery.json (editável à mão — re-rodar sobrescreve!)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
// O tipo vem de quem PRODUZ o arquivo. A cópia local que existia aqui ficou
// defasada quando a Fase 1.5 acrescentou `featCategory` ao classificador: o
// filtro já usava o campo e o tipo negava que ele existisse.
import type { ClassifiedFeat } from "./classify-feats.js";

const here = dirname(fileURLToPath(import.meta.url));
const GENERATED = join(here, "../../data/pf2e/generated");
const OUT = join(here, "battery.json");


const PER_ARCHETYPE = 5;

/** Feats do exemplo_personagem.json (Jão): sempre incluídos se o arquétipo entra. */
const EXAMPLE_FEATS = new Set([
  "Charming Liar",
  "Unbreakable Goblin",
  "Bon Mot",
  "Twin Feint",
  "Goblin Scuttle",
  "Dirty Trick",
  "Distracting Feint",
  "Incredible Initiative",
  "Lie to Me",
  "Sow Rumor",
  "Twin Distraction",
  "Secret Speech",
  "Kneecap",
]);

/** Arquétipos que entram na bateria (magia/ambíguo ficam para a fase caster). */
const COMBAT_ARCHETYPES = [
  "atividade-multi-strike",
  "strike-modificada",
  "condicao-via-check",
  "reacao-defensiva",
  "reacao-ofensiva",
  "stance",
  "movimento-tatico",
  "buff-suporte",
  "passivo-combate",
  "combate-outro",
];
const NONCOMBAT_ARCHETYPES = [
  "skill-activity",
  "downtime",
  "social-influencia",
  "exploracao",
  "passivo-utilitario",
];

/** Classes marciais/skill que os templates (Fighter 5 / Rogue 5 goblin) cobrem. */
const TESTABLE_TRAITS = new Set([
  "fighter",
  "rogue",
  "barbarian",
  "ranger",
  "champion",
  "monk",
  "swashbuckler",
  "general",
  "skill",
  "goblin",
]);

/** Ancestralidades que os templates NÃO têm (Fighter humano / Rogue goblin). */
const FOREIGN_ANCESTRIES = new Set([
  "dwarf", "elf", "gnome", "halfling", "leshy", "orc", "catfolk", "kobold",
  "tengu", "azarketi", "lizardfolk", "hobgoblin", "ratfolk", "fetchling",
  "gnoll", "kholo", "grippli", "tripkee", "nagaji", "vanara", "vishkanya",
  "android", "automaton", "fleshwarp", "kitsune", "sprite", "strix", "poppet",
  "anadi", "conrasu", "shisk", "goloma", "skeleton", "shoony", "minotaur",
  "tanuki", "wayang", "athamaru", "surki", "yaksha", "yaoguai", "merfolk",
  "centaur", "awakened animal", "sarangay", "samsaran", "hungerseed",
  "aiuvarin", "dromaar", "nephilim", "beastkin", "changeling", "dhampir",
  "duskwalker", "geniekin", "ifrit", "oread", "suli", "sylph", "undine",
  "aasimar", "tiefling", "ganzi", "aphorite",
]);

function testable(f: ClassifiedFeat): boolean {
  // Sem raridade exótica, nível jogável, e de classe/origem que os templates têm
  // (ou feat genérico sem trait de classe).
  if (f.rarity && f.rarity !== "common") return false;
  if ((f.level ?? 1) > 6) return false;
  if (f.traits.includes("archetype") || f.traits.includes("dedication")) return false;
  if (f.traits.includes("mythic") || f.traits.includes("destiny")) return false;
  // Boons de PFS, boons/curses de divindade e entradas administrativas não são
  // feats jogáveis. A taxonomia é NATIVA do Foundry (system.category, importada
  // na Fase 1.5) — antes isso era adivinhado por regex sobre o TÍTULO
  // ("/^[A-Z]?\d+-\d+/" para PFS, "- Minor Curse" para curses…), a duplicação
  // artesanal que o import total aposentou.
  const NOT_PLAYABLE = new Set(["pfsboon", "deityboon", "curse", "bonus"]);
  if (f.featCategory && NOT_PLAYABLE.has(f.featCategory)) return false;
  // NOTA: classfeature/ancestryfeature seguem NO pool por ora — a bateria atual
  // contém classfeatures e excluí-las é decisão de REDESENHO da bateria (fila
  // do roadmap), não desta troca de filtro.
  if (f.traits.some((t) => FOREIGN_ANCESTRIES.has(t))) return false;
  const classTraits = f.traits.filter((t) => TESTABLE_TRAITS.has(t));
  const hasForeignClass = f.traits.some((t) =>
    [
      "alchemist",
      "bard",
      "cleric",
      "druid",
      "wizard",
      "witch",
      "sorcerer",
      "oracle",
      "psychic",
      "magus",
      "summoner",
      "kineticist",
      "thaumaturge",
      "inventor",
      "gunslinger",
      "investigator",
      "exemplar",
      "animist",
      "necromancer",
      "guardian",
      "runesmith",
    ].includes(t),
  );
  return classTraits.length > 0 || !hasForeignClass;
}

/** Correções pontuais de arquétipo para feats conhecidos (o regex erra o tipo). */
const FORCED_ARCHETYPE: Record<string, string> = {
  "Twin Feint": "atividade-multi-strike",
  "Reactive Shield": "reacao-defensiva",
  "Goblin Scuttle": "reacao-defensiva",
};

function pick(feats: ClassifiedFeat[], archetype: string): ClassifiedFeat[] {
  const seen = new Set<string>();
  const pool = feats.filter((f) => {
    if (seen.has(f.name)) return false; // dataset tem nomes duplicados entre packs
    seen.add(f.name);
    const arch = FORCED_ARCHETYPE[f.name] ?? f.archetype;
    return arch === archetype && testable(f);
  });
  const chosen: ClassifiedFeat[] = [];
  const usedClasses = new Set<string>();

  // 1. Feats do exemplo primeiro.
  for (const f of pool) {
    if (EXAMPLE_FEATS.has(f.name) && chosen.length < PER_ARCHETYPE) {
      chosen.push(f);
      for (const t of f.traits) usedClasses.add(t);
    }
  }
  // 2. Completa com core nível ≤6, priorizando diversidade de classe.
  const rest = pool
    .filter((f) => !chosen.includes(f))
    .sort((a, b) => (a.level ?? 0) - (b.level ?? 0) || a.name.localeCompare(b.name));
  for (const f of rest) {
    if (chosen.length >= PER_ARCHETYPE) break;
    const cls = f.traits.find((t) => TESTABLE_TRAITS.has(t)) ?? "geral";
    if (usedClasses.has(cls) && rest.some((g) => !chosen.includes(g) && !usedClasses.has(g.traits.find((t) => TESTABLE_TRAITS.has(t)) ?? "geral"))) {
      continue; // deixa espaço para classe ainda não representada
    }
    chosen.push(f);
    usedClasses.add(cls);
  }
  // 3. Se sobrou vaga (pool pequeno), preenche sem restrição de classe.
  for (const f of rest) {
    if (chosen.length >= PER_ARCHETYPE) break;
    if (!chosen.includes(f)) chosen.push(f);
  }
  return chosen;
}

function main() {
  const all = JSON.parse(
    readFileSync(join(here, "feats-classified.json"), "utf8"),
  ) as ClassifiedFeat[];

  const battery = {
    generatedAt: new Date().toISOString().slice(0, 10),
    note: "Editável à mão. Re-rodar select-battery.ts sobrescreve.",
    combat: {} as Record<string, unknown[]>,
    noncombat: {} as Record<string, unknown[]>,
  };

  let cTotal = 0;
  for (const arch of COMBAT_ARCHETYPES) {
    const sel = pick(all, arch);
    battery.combat[arch] = sel.map((f) => ({
      name: f.name,
      level: f.level,
      actionType: f.actionType,
      actionCost: f.actionCost,
      traits: f.traits,
    }));
    cTotal += sel.length;
  }
  let nTotal = 0;
  for (const arch of NONCOMBAT_ARCHETYPES) {
    const sel = pick(all, arch);
    battery.noncombat[arch] = sel.map((f) => ({
      name: f.name,
      level: f.level,
      actionType: f.actionType,
      actionCost: f.actionCost,
      traits: f.traits,
    }));
    nTotal += sel.length;
  }

  writeFileSync(OUT, JSON.stringify(battery, null, 2));
  console.log(`battery.json: ${cTotal} combate + ${nTotal} fora = ${cTotal + nTotal} cenários`);
  for (const [arch, list] of Object.entries(battery.combat)) {
    console.log(`  [C] ${arch}: ${(list as unknown[]).length} → ${(list as { name: string }[]).map((f) => f.name).join(", ")}`);
  }
  for (const [arch, list] of Object.entries(battery.noncombat)) {
    console.log(`  [F] ${arch}: ${(list as unknown[]).length} → ${(list as { name: string }[]).map((f) => f.name).join(", ")}`);
  }
}

main();
