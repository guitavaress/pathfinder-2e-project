/**
 * A ponte entre o estado da engine e o vocabulário do dado (Fase 2.5 / T5.1).
 *
 * A T2 publicou `rollOptionsFor` e a T3 o avaliador de predicados, mas nada
 * chamava nem um nem outro: `gm/` importava de `rules/` só `dataset`, `damage`,
 * `modifiers` e `condition-modifiers`. Resultado prático — `conditionModifiersFor`
 * recebia `ro` indefinido e DESCARTAVA todo `FlatModifier` com predicado. Este
 * módulo é o import que faltava.
 *
 * Impuro de propósito (resolve traços/tipo de dano pelo dataset), como
 * `condition-modifiers.ts`. `gm/combat.ts` continua puro e recebe as opções
 * prontas de quem as montou.
 *
 * A regra de honestidade da T2 vale inteira aqui: só se afirma o que o estado
 * sustenta. Onde a arma é ambígua (arremessável serve de corpo a corpo E à
 * distância), NADA é afirmado — indecidível é melhor que um falso inventado,
 * porque um `not:` transformaria o palpite em permissão.
 */
import type { Character, Combatant } from "@pf2e/shared";
import { itemRecord } from "./dataset.js";
import { normalizeDamageType } from "./damage.js";
import {
  rollOptionsFor,
  slug,
  type RollOptionActor,
  type RollOptionItem,
  type RollOptions,
} from "./roll-options.js";

export interface CheckContextInput {
  /** Ficha do jogador — só ela traz classe, feats, features e perícias. */
  character?: Character;
  /** Combatente que rola. Fora de combate não existe; use `selfConditions`. */
  self?: Combatant;
  /** Condições do jogador fora de combate (`GameState.conditions`). */
  selfConditions?: string[];
  target?: Combatant;
  /** Ação/atividade sendo resolvida, como o dado a nomeia ("Strike", "Trip"). */
  action?: string;
  /** Nome do item/arma em uso; traços e tipo de dano saem do dataset. */
  item?: string;
  /** Tipo de dano, quando quem chama já sabe (magia, ataque de statblock). */
  damageType?: string;
  /** Corpo a corpo / à distância, quando a engine sabe. Vence o palpite do dado. */
  melee?: boolean;
  ranged?: boolean;
  /** Rank de conjuração, para magias. */
  rank?: number;
}

/**
 * `ancestry` entra TAMBÉM como traço do ator: em PF2e a ancestralidade é um
 * traço da criatura, e `self:trait:elf` é como metade do dado pergunta isso.
 * Sem ele, `self:trait` ficaria coberto com conjunto vazio — e um elfo
 * responderia FALSO a "é elfo", que é pior que não saber.
 */
function playerActor(c: Character, combatant?: Combatant, conditions?: string[]): RollOptionActor {
  const traits = new Set<string>(combatant?.traits ?? []);
  if (c.ancestry) traits.add(slug(c.ancestry));

  // Campo ausente fica ausente, nunca vira `{}`/`[]`: `rollOptionsFor` marca o
  // domínio como COBERTO quando o campo existe, e um conjunto vazio coberto
  // responderia "destreinado"/"não tem o feat" onde a verdade é "não sei".
  let skills: Record<string, { rank: number }> | undefined;
  if (c.skills || c.lores?.length) {
    skills = {};
    for (const [name, s] of Object.entries(c.skills ?? {})) skills[name] = { rank: s.rank };
    // Lores são perícias com nome livre — `skill:sailing-lore:rank:1` é como o
    // dado as escreve, e ignorá-las diria "destreinado" a quem é treinado.
    for (const l of c.lores ?? []) skills[`${l.name} lore`] = { rank: l.rank };
  }

  return {
    kind: combatant?.kind ?? "player",
    level: combatant?.level ?? c.level,
    traits: [...traits],
    conditions: combatant?.conditions ?? conditions ?? [],
    ...(c.className ? { className: c.className } : {}),
    ...(c.ancestry ? { ancestry: c.ancestry } : {}),
    ...(c.heritage ? { heritage: c.heritage } : {}),
    ...(c.feats ? { feats: c.feats } : {}),
    ...(c.classFeatures ? { classFeatures: c.classFeatures } : {}),
    ...(skills ? { skills } : {}),
  };
}

/** Um combatente sem ficha (inimigo, aliado): só o que o statblock sustenta. */
function combatantActor(c: Combatant): RollOptionActor {
  return {
    kind: c.kind,
    level: c.level,
    traits: c.traits,
    conditions: c.conditions,
  };
}

/**
 * Traços da arma/item pelo dataset. Melee/ranged só são afirmados quando o
 * dado decide sozinho: arma COM alcance e SEM traço de arremesso é à distância;
 * arma SEM alcance e sem arremesso é corpo a corpo. Arremessável fica em
 * aberto — quem chama diz, se souber.
 */
function itemOptions(input: CheckContextInput): RollOptionItem | undefined {
  const name = input.item?.trim();
  if (!name && input.damageType === undefined && input.rank === undefined) return undefined;

  const rec = name ? itemRecord(name) : null;
  const traits = rec?.traits ?? [];
  const throwable = traits.some((t) => /^thrown\b/.test(slug(t)));
  const hasRange = typeof rec?.range === "number" && rec.range > 0;

  const item: RollOptionItem = {};
  if (name) item.name = rec?.name ?? name;
  if (traits.length) item.traits = traits;
  if (rec?.docType) item.type = rec.docType;
  if (rec?.weaponCategory) item.category = rec.weaponCategory;
  // `itemRecord` já desmonta runas e material, então o nome que ele devolve é o
  // item BASE — é isso que `item:base:*` quer dizer.
  if (rec) item.base = rec.name;

  const damageType = input.damageType ?? rec?.damage?.type;
  if (damageType !== undefined) {
    const normalized = normalizeDamageType(damageType);
    if (normalized) item.damageType = normalized;
  }
  if (typeof input.rank === "number") item.rank = input.rank;

  const melee = input.melee ?? (rec && !throwable ? !hasRange : undefined);
  const ranged = input.ranged ?? (rec && !throwable ? hasRange : undefined);
  if (typeof melee === "boolean") item.melee = melee;
  if (typeof ranged === "boolean") item.ranged = ranged;

  return Object.keys(item).length ? item : undefined;
}

/**
 * Traduz o estado do turno nas roll options que os rule elements testam.
 * Tudo é opcional: quanto menos o contexto traz, menos fica DECIDÍVEL — e o
 * avaliador trata indecidível como "não sei", nunca como falso.
 */
export function rollOptionsForCheck(input: CheckContextInput): RollOptions {
  const self = input.character
    ? playerActor(input.character, input.self, input.selfConditions)
    : input.self
      ? combatantActor(input.self)
      : undefined;

  return rollOptionsFor({
    ...(self ? { self } : {}),
    ...(input.target ? { target: combatantActor(input.target) } : {}),
    ...(input.action ? { action: input.action } : {}),
    ...(() => {
      const item = itemOptions(input);
      return item ? { item } : {};
    })(),
  });
}
