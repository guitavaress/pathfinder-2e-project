/**
 * A paleta do jogador (Fase 2.7 / T7.4).
 *
 * O que a FICHA nomeia, resolvido contra o dataset: nome, categoria, uuid e
 * custo de ação. É o que a UI mostra quando o jogador digita `@`, e é de onde
 * sai a referência que vai fixada no turno.
 *
 * Por que no servidor: o uuid e o custo só existem no dataset, que a web não
 * carrega. E o mesmo `sheetCategoriesOf` que decide a colisão no `lookup_rule`
 * decide aqui — uma fonte só, senão a paleta oferece uma coisa e o portão
 * resolve outra.
 *
 * Nome que a ficha tem e o dado NÃO conhece continua aparecendo, sem uuid: a
 * paleta é a ficha do jogador, não o catálogo do que a engine sabe fazer.
 * Escondê-lo seria a UI mentindo sobre o personagem.
 */
import type { Character } from "@pf2e/shared";
import { actionLabel, itemRecord, lookupInCategory } from "../rules/dataset.js";
import { sheetCategoriesOf, type SheetCategory } from "../rules/sheet-lookup.js";

/** Agrupamento da UI — mais grosso que a categoria do dataset, de propósito. */
export type PaletteGroup = "ability" | "spell" | "item" | "identity";

export interface PaletteEntry {
  name: string;
  /** Categoria do dataset, o que a referência leva ao `lookup_rule`. */
  category: string;
  /** uuid do documento, quando o dado conhece o nome. */
  uuid?: string;
  /** "1 action" | "reaction" | "free action" | "" — do dado, não do palpite. */
  cost?: string;
  group: PaletteGroup;
}

const GROUP_OF: Record<SheetCategory, PaletteGroup> = {
  feats: "ability",
  spells: "spell",
  equipment: "item",
  ancestries: "identity",
  heritages: "identity",
  backgrounds: "identity",
  classes: "identity",
  deities: "identity",
};

const GROUP_ORDER: PaletteGroup[] = ["ability", "spell", "item", "identity"];

/**
 * Mantém o nome como a FICHA escreve, não como o dado grafa.
 *
 * O dado tem "Shake it Off" e a ficha "Shake It Off"; quem lê a tela é o
 * jogador, e o texto que ele manda precisa continuar sendo o dele. A
 * desambiguação viaja no `category`/`uuid`, que não dependem de grafia.
 */
export function buildPalette(character: Character): PaletteEntry[] {
  const out: PaletteEntry[] = [];
  const seen = new Set<string>();
  for (const [key, cats] of sheetCategoriesOf(character)) {
    for (const cat of cats) {
      const dedupe = `${key}::${cat}`;
      if (seen.has(dedupe)) continue;
      seen.add(dedupe);
      // Equipamento resolve pelo `itemRecord`, que é o MESMO grounding de item
      // que a engine usa em combate: ele descasca runa ("+1 Striking Rapier" →
      // "Rapier") e conhece a convenção de variante do dataset ("Studded
      // Leather" → "Studded Leather Armor"). Com o `lookupInCategory` cru a
      // paleta perdia o uuid justamente da arma empunhada — a paleta oferecia
      // uma coisa e o portão da ficha resolvia outra, que é o que este arquivo
      // existe para impedir.
      const rec = (cat === "equipment" ? itemRecord(key) : null) ?? lookupInCategory(key, cat);
      const cost = rec ? actionLabel(rec) : "";
      out.push({
        name: displayName(character, key) ?? rec?.name ?? key,
        category: cat,
        ...(rec?.uuid ? { uuid: rec.uuid } : {}),
        ...(cost ? { cost } : {}),
        group: GROUP_OF[cat],
      });
    }
  }
  return out.sort(
    (a, b) =>
      GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) ||
      a.name.localeCompare(b.name),
  );
}

/** A grafia que o jogador vê na própria ficha, para a chave normalizada. */
function displayName(character: Character, key: string): string | null {
  const pools: unknown[] = [
    ...(character.feats ?? []),
    ...(character.classFeatures ?? []),
    ...(character.spellcasting ?? []).flatMap((sc) => sc.spells ?? []),
    ...(character.equipment ?? []).map((e) => e.name),
    ...(character.weapons ?? []).map((w) => w.name),
    ...(character.armor ?? []).map((a) => a.name),
    character.ancestry,
    character.heritage,
    character.background,
    character.className,
    character.deity,
  ];
  for (const p of pools) {
    if (typeof p === "string" && p.toLowerCase().trim() === key) return p;
  }
  return null;
}
