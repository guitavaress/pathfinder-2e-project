/**
 * Os modificadores que a FICHA do jogador aplica, lidos do dado (Fase 2.5 / T5.3).
 *
 * Até aqui a engine tinha uma tabela escrita à mão com UMA entrada
 * (`PASSIVE_FEAT_EFFECTS` em `gm/combat.ts`) para 4.925 feats passivos no
 * dataset. Este módulo troca a tabela pelo dado: os `FlatModifier` dos feats,
 * features de classe, herança, ancestralidade e antecedente que a ficha nomeia.
 *
 * São 781 `FlatModifier` nessas cinco categorias, **712 deles com predicado** —
 * e é esse número que decide o desenho. Um modificador condicional não pode
 * estar embutido num número estático de ficha; um incondicional quase sempre
 * está. Daí a regra abaixo.
 *
 * ## Não-duplo-cômputo (a restrição que manda aqui)
 *
 * O export do Pathbuilder traz VALORES FINAIS: `ac`, `perception`, `saves.*`,
 * `skills[x].modifier`, `weapons[].attack` já somam o que os feats dão. Somar o
 * `FlatModifier` por cima contaria duas vezes. Então:
 *
 * - seletor cujo número base vem da ficha → só aplica modificador COM predicado;
 * - seletor que a ENGINE compõe (iniciativa, dano) → aplica com e sem predicado.
 *
 * O que não é aplicado não some: sai em `skipped`, com o motivo. Dívida
 * visível — mesma regra da T3, onde indecidível nunca vira permissão.
 */
import type { Character } from "@pf2e/shared";
import { categoryRecords, type RuleRecord } from "./dataset.js";
import { modifierType, type Modifier } from "./modifiers.js";
import { evaluate } from "./predicate.js";
import { slug, type RollOptions } from "./roll-options.js";

/**
 * Seletores cujo número a engine COMPÕE — a ficha não os traz prontos, então
 * não há o que duplicar. Todo o resto é presumido embutido: o default
 * conservador erra para o lado de não aplicar, nunca para o de contar duas vezes.
 */
export const ENGINE_COMPOSED_SELECTORS = new Set([
  "initiative",
  "damage",
  "strike-damage",
  "weapon-damage",
  "unarmed-damage",
  "spell-damage",
]);

export type SkipReason =
  | "predicate-unknown"
  | "predicate-false"
  | "value-unresolved"
  | "assumed-in-sheet";

export interface ActorModifierSkip {
  /** Documento de origem ("Incredible Initiative"). */
  source: string;
  slug: string;
  reason: SkipReason;
  /** A expressão crua, quando o motivo é não sabermos resolvê-la. */
  detail?: string;
}

export interface ActorModifiers {
  applied: Modifier[];
  skipped: ActorModifierSkip[];
}

/** Um FlatModifier de ficha, na forma crua do dado + o doc que o carrega. */
interface SheetModifier {
  source: string;
  slug: string;
  selectors: string[];
  type: string;
  /** Número resolvido, ou null quando a expressão não foi resolvida. */
  value: number | null;
  /** A expressão que não soubemos resolver — declarada, nunca chutada. */
  unresolved?: string;
  hasPredicate: boolean;
  predicate?: unknown;
}

/**
 * Precedência entre categorias com nomes homônimos. `feats` primeiro porque é
 * de lá que vem quase tudo que a ficha nomeia; `actions` fica FORA de propósito
 * — "Shield Block" em `actions` é a ação genérica, não o feat do personagem.
 */
const SHEET_CATEGORIES = ["feats", "classes", "heritages", "ancestries", "backgrounds"] as const;

let byName: Map<string, SheetModifier[]> | null = null;

function normalize(name: string): string {
  return name.toLowerCase().trim();
}

function flatModifiersOf(rec: RuleRecord): SheetModifier[] {
  const out: SheetModifier[] = [];
  for (const raw of rec.rules ?? []) {
    const r = raw as Record<string, unknown>;
    if (r.key !== "FlatModifier") continue;
    const selectors = Array.isArray(r.selector)
      ? r.selector.filter((s): s is string => typeof s === "string")
      : typeof r.selector === "string"
        ? [r.selector]
        : [];
    if (selectors.length === 0) continue;
    out.push({
      source: rec.name,
      slug: typeof r.slug === "string" ? r.slug : slug(rec.name),
      selectors,
      type: typeof r.type === "string" ? r.type : "",
      ...resolveValue(r.value),
      hasPredicate: r.predicate !== undefined,
      ...(r.predicate === undefined ? {} : { predicate: r.predicate }),
    });
  }
  return out;
}

/**
 * 641 dos 781 valores são número puro. Os 134 restantes são expressões do
 * Foundry (`@actor.level`, `ternary(gte(...))`, `@weapon.system.damage.dice`)
 * que dependem de um avaliador que não temos — ficam DECLARADAS. Inventar um
 * número aqui seria pior do que não aplicar: erraria calado.
 */
function resolveValue(raw: unknown): Pick<SheetModifier, "value" | "unresolved"> {
  if (typeof raw === "number" && Number.isFinite(raw)) return { value: raw };
  if (typeof raw === "string" && raw.trim()) return { value: null, unresolved: raw };
  return { value: null };
}

function index(): Map<string, SheetModifier[]> {
  if (byName) return byName;
  byName = new Map();
  for (const category of SHEET_CATEGORIES) {
    for (const rec of categoryRecords(category)) {
      const key = normalize(rec.name);
      // Primeiro-ganha: a ordem de SHEET_CATEGORIES é a precedência.
      if (byName.has(key)) continue;
      const mods = flatModifiersOf(rec);
      if (mods.length) byName.set(key, mods);
    }
  }
  return byName;
}

/** Os nomes de documento que a ficha aponta, na ordem em que aparecem nela. */
function sheetSources(c: Character): string[] {
  return [
    ...(c.feats ?? []),
    ...(c.classFeatures ?? []),
    ...(c.heritage ? [c.heritage] : []),
    ...(c.ancestry ? [c.ancestry] : []),
    ...(c.className ? [c.className] : []),
    ...(c.background ? [c.background] : []),
  ];
}

/** Os FlatModifiers que a ficha carrega, sem filtro de seletor. */
export function sheetModifiers(c: Character): SheetModifier[] {
  const idx = index();
  const out: SheetModifier[] = [];
  const seen = new Set<string>();
  for (const name of sheetSources(c)) {
    const key = normalize(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(...(idx.get(key) ?? []));
  }
  return out;
}

/**
 * Os modificadores da ficha que incidem sobre um seletor, com o que ficou de
 * fora e por quê.
 *
 * `ro` é o contexto da rolagem do ponto de vista do JOGADOR (é dele a ficha).
 * Sem `ro`, todo modificador com predicado fica em `skipped` — o que, num
 * seletor vindo da ficha, significa aplicar nada.
 */
export function actorModifiersFor(
  c: Character,
  selector: string | string[],
  ro?: RollOptions,
): ActorModifiers {
  const applied: Modifier[] = [];
  const skipped: ActorModifierSkip[] = [];
  // Uma rolagem casa com VÁRIOS seletores do dado (um save de Vontade é
  // `saving-throw` e `will`), e um modificador que atende a dois deles ainda
  // conta uma vez só — por isso a iteração é pelos modificadores, não pelos
  // seletores.
  const wanted = new Set(typeof selector === "string" ? [selector] : selector);
  const composed = [...wanted].some((s) => ENGINE_COMPOSED_SELECTORS.has(s));

  for (const mod of sheetModifiers(c)) {
    if (!mod.selectors.some((s) => wanted.has(s) || s === "all")) continue;

    if (!mod.hasPredicate && !composed) {
      // Incondicional num número que a ficha já traz pronto: o Pathbuilder já
      // somou. Declarado, não aplicado.
      skipped.push({ source: mod.source, slug: mod.slug, reason: "assumed-in-sheet" });
      continue;
    }
    if (mod.hasPredicate) {
      const verdict = ro ? evaluate(mod.predicate, ro).value : "unknown";
      if (verdict !== "true") {
        skipped.push({
          source: mod.source,
          slug: mod.slug,
          reason: verdict === "false" ? "predicate-false" : "predicate-unknown",
        });
        continue;
      }
    }
    if (mod.value === null) {
      skipped.push({
        source: mod.source,
        slug: mod.slug,
        reason: "value-unresolved",
        ...(mod.unresolved ? { detail: mod.unresolved } : {}),
      });
      continue;
    }
    if (mod.value === 0) continue;
    applied.push({
      slug: mod.slug,
      type: modifierType(mod.type),
      value: mod.value,
      source: mod.source,
    });
  }
  return { applied, skipped };
}


/** Só para teste: força a releitura do índice. */
export function resetSheetModifierIndex(): void {
  byName = null;
}
