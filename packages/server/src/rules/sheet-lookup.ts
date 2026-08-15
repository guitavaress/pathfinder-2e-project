/**
 * Desambiguação de nomes colididos (Fase 2.7).
 *
 * O dataset tem 309 nomes que existem em duas ou mais categorias — `Shake It
 * Off` é uma reação em `actions` E um feat de bárbaro em `feats`, com textos
 * DIFERENTES. O índice por nome é primeiro-ganha por precedência de categoria
 * (`NAME_INDEX_ORDER`), então o GM lia a errada em 47 dos 53 casos medidos.
 *
 * Três caminhos, nesta ordem de força:
 *
 * 1. **Referência explícita** (`ref` uuid ou `category`) — quem sabe qual é
 *    diz qual é. É o canal da paleta da UI: o jogador clica na habilidade da
 *    própria ficha e a ambiguidade morre na origem, antes do modelo. Não há
 *    casamento por nome, logo não há colisão possível.
 * 2. **Portão da ficha** — se o personagem NOMEIA um dos lados (feat, magia,
 *    item, ancestralidade…), aquele é o certo, e a engine decide em código.
 *    Mede-se: 167 das 309 colisões (54%) têm exatamente um lado nomeável.
 * 3. **Índice** — o caminho da prosa livre, inalterado. Quando a ficha nomeia
 *    DOIS lados (128 colisões) ou nenhum (14), o principal continua vindo da
 *    precedência e os homônimos são LISTADOS: o dado não se esconde.
 *
 * Módulo impuro (carrega o dataset), como `condition-modifiers.ts`.
 */
import type { Character } from "@pf2e/shared";
import {
  byUuid,
  homonymsOf,
  lookupInCategory,
  lookupLocalRule,
  type RuleRecord,
} from "./dataset.js";

/**
 * Categorias que uma FICHA sabe nomear, e o campo de onde o nome vem.
 *
 * O que não está aqui (`actions`, `conditions`, `bestiary`, `hazards`,
 * `effects`…) nunca é escolhido pelo portão — não porque seja menos válido,
 * mas porque a ficha não tem como afirmar nada sobre ele.
 */
const SHEET_CATEGORIES = [
  "feats",
  "spells",
  "equipment",
  "ancestries",
  "heritages",
  "backgrounds",
  "classes",
  "deities",
] as const;

export type SheetCategory = (typeof SHEET_CATEGORIES)[number];

/** Como o registro principal foi escolhido — auditável, nunca escondido. */
export type LookupVia = "uuid" | "category" | "sheet" | "index";

export interface SheetLookup {
  primary: RuleRecord | null;
  /** Os outros registros com o mesmo nome, em outras categorias. */
  homonyms: RuleRecord[];
  via: LookupVia;
  /** true quando havia colisão e a ficha NÃO decidiu (nomeia 2+ lados, ou nenhum). */
  ambiguous: boolean;
}

function norm(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * `unknown` e não `string` de propósito: o tipo `Character` promete os campos,
 * a realidade não. Save antigo, fixture parcial e export do Pathbuilder sem
 * herança chegam aqui com `undefined` — e uma CONSULTA DE REGRA não pode
 * derrubar o turno porque a ficha não tem ancestralidade.
 */
function add(map: Map<string, Set<SheetCategory>>, name: unknown, cat: SheetCategory): void {
  if (typeof name !== "string") return;
  const k = norm(name);
  if (!k) return;
  const set = map.get(k);
  if (set) set.add(cat);
  else map.set(k, new Set([cat]));
}

/**
 * O que a ficha nomeia, por categoria do dataset.
 *
 * `classFeatures` cai em `feats` porque é lá que o dado guarda os traços de
 * classe (`featCategory: "classfeature"`, 824 docs) — não há categoria
 * separada. Armas e armaduras entram como `equipment` pelo mesmo motivo.
 */
export function sheetCategoriesOf(character: Character): Map<string, Set<SheetCategory>> {
  const map = new Map<string, Set<SheetCategory>>();
  for (const f of character.feats ?? []) add(map, f, "feats");
  for (const f of character.classFeatures ?? []) add(map, f, "feats");
  for (const sc of character.spellcasting ?? []) {
    for (const s of sc.spells ?? []) add(map, s, "spells");
  }
  for (const e of character.equipment ?? []) add(map, e.name, "equipment");
  for (const w of character.weapons ?? []) add(map, w.name, "equipment");
  for (const a of character.armor ?? []) add(map, a.name, "equipment");
  add(map, character.ancestry, "ancestries");
  if (character.heritage) add(map, character.heritage, "heritages");
  add(map, character.background, "backgrounds");
  add(map, character.className, "classes");
  if (character.deity) add(map, character.deity, "deities");
  return map;
}

export interface LookupOptions {
  /** uuid (ou referência `Compendium.…`) do documento — a forma mais forte. */
  ref?: string;
  /** Categoria explícita do dataset. */
  category?: string;
}

/**
 * Resolve uma consulta de regra usando, nesta ordem: referência explícita →
 * portão da ficha → índice.
 *
 * A referência explícita que NÃO resolve não cai silenciosamente no índice
 * como se nada tivesse acontecido — cai, mas o `via` conta a verdade, e quem
 * chama pode dizer ao modelo que a referência não existia. Silêncio aqui seria
 * a mesma armadilha do `dc ?? 0`.
 */
export function lookupForSheet(
  character: Character,
  query: string,
  opts: LookupOptions = {},
): SheetLookup {
  if (opts.ref) {
    const byRef = byUuid(opts.ref);
    if (byRef) return { primary: byRef, homonyms: homonymsOf(byRef), via: "uuid", ambiguous: false };
  }
  if (opts.category) {
    const inCat = lookupInCategory(query, opts.category);
    if (inCat) {
      return { primary: inCat, homonyms: homonymsOf(inCat), via: "category", ambiguous: false };
    }
  }

  const found = lookupLocalRule(query);
  if (!found) return { primary: null, homonyms: [], via: "index", ambiguous: false };

  const homonyms = homonymsOf(found);
  if (homonyms.length === 0) {
    return { primary: found, homonyms, via: "index", ambiguous: false };
  }

  // Portão da ficha. Compara pelo nome do registro ENCONTRADO, não pela
  // consulta crua: o `lookupLocalRule` pode ter casado por substring.
  const owned = sheetCategoriesOf(character).get(norm(found.name));
  if (!owned || owned.size === 0) {
    return { primary: found, homonyms, via: "index", ambiguous: true };
  }
  const candidates = [found, ...homonyms].filter((r) => owned.has(r.category as SheetCategory));
  if (candidates.length === 1) {
    const primary = candidates[0]!;
    return { primary, homonyms: homonymsOf(primary), via: "sheet", ambiguous: false };
  }
  // A ficha nomeia dois lados (ex.: tem o feat E o item homônimo). Ela não
  // decide — quem decide é o contexto da cena, com os homônimos à vista.
  return { primary: found, homonyms, via: "index", ambiguous: true };
}
