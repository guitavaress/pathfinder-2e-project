/**
 * Roll options: o estado do turno traduzido para o vocabulário do dado.
 *
 * Rule elements do pf2e não descrevem condições em prosa — testam PREDICADOS
 * sobre afirmações em kebab-case a respeito do jogo (`target:condition:off-guard`,
 * `item:trait:agile`, `action:trip`). Sem esse conjunto, cada rule element vira
 * caso especial em código; com ele, viram dado (T3 avalia, T4 aplica).
 *
 * Módulo PURO: quem chama resolve o dado (traços via `itemTraits`) e passa
 * pronto. Assim ele é testável sem carregar o dataset.
 *
 * A regra de honestidade deste módulo: **ausência não é negação**. Se o
 * contexto não traz alvo, `target:*` não é "falso" — é indecidível, e
 * `covered` diz isso. Responder falso por omissão faria predicado passar
 * (`not:`) exatamente onde não deveria.
 */

/** Um combatente do ponto de vista das roll options. */
export interface RollOptionActor {
  kind?: "player" | "ally" | "enemy";
  level?: number | null;
  traits?: string[];
  /** Condições como a engine guarda: "off-guard", "frightened 2". */
  conditions?: string[];
  /** Só o jogador tem ficha: classe, feats, features e perícias. */
  className?: string;
  ancestry?: string;
  heritage?: string | null;
  feats?: string[];
  classFeatures?: string[];
  skills?: Record<string, { rank: number }>;
  /**
   * Slugs dos efeitos ATIVOS neste ator (Fase 2.6). Presente — mesmo vazio —
   * significa "sei quais são"; ausente significa "não sei", e aí
   * `self:effect:*` continua indecidível. É a diferença entre a engine afirmar
   * que o personagem não está enfurecido e a engine não ter ideia.
   */
  effects?: string[];
}

/** A arma/magia/item em uso, com os traços JÁ resolvidos do dataset. */
export interface RollOptionItem {
  name?: string;
  traits?: string[];
  /** "weapon" | "spell" | "armor" | "consumable"… */
  type?: string;
  /** Categoria da arma ("unarmed", "simple", "martial"). */
  category?: string;
  /** Item BASE, sem runas nem material ("Longsword +1 striking" → longsword).
   *  Quem chama resolve pelo dataset; aqui só vira opção. */
  base?: string;
  melee?: boolean;
  ranged?: boolean;
  damageType?: string;
  /** Rank de conjuração, para magias. */
  rank?: number;
}

export interface RollOptionContext {
  self?: RollOptionActor;
  target?: RollOptionActor;
  /** Ação/atividade sendo resolvida, como o nome do dado ("Trip", "Strike"). */
  action?: string;
  item?: RollOptionItem;
}

export interface RollOptions {
  /** Tudo que o estado atual AFIRMA. */
  options: Set<string>;
  /**
   * Prefixos cuja extensão está completa neste contexto — só aí a ausência de
   * uma opção significa "falso". Fora deles, indecidível.
   */
  covered: Set<string>;
}

/**
 * Prefixos que a engine sabe enumerar quando o pedaço de contexto existe.
 * Tudo que NÃO estiver aqui fica declarado como não coberto — a lista cresce
 * conforme a engine passa a modelar cada coisa.
 */
export const COVERABLE_PREFIXES = [
  "self:type",
  "self:level",
  "self:trait",
  "self:condition",
  "self:effect",
  "class",
  "ancestry",
  "heritage",
  "feat",
  "feature",
  "skill",
  "target:type",
  "target:level",
  "target:trait",
  "target:condition",
  "action",
  "item:trait",
  "item:type",
  "item:category",
  "item:base",
  "item:damage:type",
  "item:slug",
  "item:rank",
  "item:melee",
  "item:ranged",
  "trait",
] as const;

/**
 * Domínios FREQUENTES que aparecem no dataset e que a engine ainda não modela.
 * Ficam nomeados para que "não sei" seja distinguível de "é falso".
 *
 * Não é — nem tenta ser — exaustiva: 441 prefixos existem, e a cauda são
 * namespaces de UM feat só (`chimera-flail:head:lion`, `fold-form:frog`),
 * gerados por ChoiceSet. Enumerá-los seria rigor falso. O que o teste de
 * conformidade garante é o que importa: nenhum domínio de peso fica de fora
 * desta lista sem ninguém perceber.
 *
 * `self:effect:*` saiu desta lista na Fase 2.6 (o registro de efeitos existe);
 * `target:effect` e `target:mark:*` (Hunt Prey e afins) seguem aqui — efeito em
 * inimigo é dívida declarada. A família posicional (`target:distance`,
 * `*:cover-level`, `self:flanking`) é Fase 3.
 */
export const DECLARED_UNCOVERED = [
  // Marcações e efeitos de TERCEIROS — o registro só cobre o jogador.
  "target:effect",
  "origin:effect",
  "self:mode",
  "self:signature",
  "self:caster",
  "self:negative-healing",
  "self:participant",
  "self:action",
  "self:heritage",
  "self:low-light-vision",
  "target:mark",
  "target:mode",
  "target:signature",
  "target:caster",
  "target:tag",
  // Posicionamento e percepção — Fase 3.
  "self:shield",
  "self:armored",
  "self:flanking",
  "self:cover-level",
  "target:distance",
  "target:size",
  "target:range-increment",
  "target:cover-level",
  "target:hidden",
  "target:audible",
  "target:enemy",
  // Equipamento além do que a ficha do Pathbuilder traz.
  "item:id",
  "item:area",
  "item:equipped",
  "item:magical",
  "item:tag",
  "item:proficiency",
  "item:group",
  "item:duration",
  "item:hands-held",
  "item:granter",
  "item:spell-slot",
  "armor",
  "weapon",
  "defense",
  "proficiency",
  // Subsistemas inteiros que a engine não modela.
  "spellcasting",
  "spellshape",
  "origin",
  "parent",
  "inflicts",
  "check",
  "terrain",
  "kinetic-gate",
  "change-shape",
  "divine-spark",
  "werecreature",
  "junction",
  "blood-magic",
  "second-blood-magic",
  "playing",
  "sanctification",
  "background-variant",
  // Introspecção da própria rolagem (modificadores já na pilha) — T4.
  "penalty",
  "bonus",
  "dice",
] as const;

/** kebab-case sem acento: o formato em que o dado escreve tudo. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Separa "frightened 2" em nome e valor (sem valor = 1, como em PF2e). */
function splitCondition(raw: string): { name: string; value: number } {
  const m = /^(.*?)(?:\s+(\d+))?$/.exec(raw.trim());
  return { name: slug(m?.[1] ?? raw), value: m?.[2] ? Number(m[2]) : 1 };
}

/** Emite as opções de um ator sob um prefixo ("self" ou "target"). */
function actorOptions(actor: RollOptionActor, prefix: "self" | "target", out: Set<string>): void {
  if (actor.kind) {
    out.add(`${prefix}:type:${actor.kind === "player" ? "character" : "npc"}`);
  }
  if (typeof actor.level === "number") out.add(`${prefix}:level:${actor.level}`);
  for (const t of actor.traits ?? []) out.add(`${prefix}:trait:${slug(t)}`);
  for (const e of actor.effects ?? []) out.add(`${prefix}:effect:${slug(e)}`);
  for (const c of actor.conditions ?? []) {
    const { name, value } = splitCondition(c);
    if (!name) continue;
    out.add(`${prefix}:condition:${name}`);
    out.add(`${prefix}:condition:${name}:${value}`);
    // O dado também usa `flat-footed` para off-guard em conteúdo pré-remaster.
    if (name === "off-guard") out.add(`${prefix}:condition:flat-footed`);
  }
}

/**
 * Traduz o estado do turno no conjunto de afirmações que os rule elements
 * testam. Só emite o que o contexto realmente sustenta.
 */
export function rollOptionsFor(ctx: RollOptionContext): RollOptions {
  const options = new Set<string>();
  const covered = new Set<string>();

  if (ctx.self) {
    actorOptions(ctx.self, "self", options);
    covered.add("self:type");
    covered.add("self:trait");
    covered.add("self:condition");
    if (typeof ctx.self.level === "number") covered.add("self:level");
    // Lista de efeitos presente (mesmo vazia) = a engine sabe quais são.
    if (ctx.self.effects) covered.add("self:effect");
    // Ficha do jogador: classe, feats e features viram domínio próprio (é
    // assim que o dado escreve — `class:barbarian`, não `self:class:...`).
    if (ctx.self.className) {
      options.add(`class:${slug(ctx.self.className)}`);
      covered.add("class");
    }
    if (ctx.self.ancestry) {
      options.add(`ancestry:${slug(ctx.self.ancestry)}`);
      covered.add("ancestry");
    }
    if (ctx.self.heritage) {
      options.add(`heritage:${slug(ctx.self.heritage)}`);
      covered.add("heritage");
    }
    if (ctx.self.feats) {
      for (const f of ctx.self.feats) options.add(`feat:${slug(f)}`);
      covered.add("feat");
    }
    if (ctx.self.classFeatures) {
      for (const f of ctx.self.classFeatures) options.add(`feature:${slug(f)}`);
      covered.add("feature");
    }
    if (ctx.self.skills) {
      for (const [name, s] of Object.entries(ctx.self.skills)) {
        options.add(`skill:${slug(name)}:rank:${s.rank}`);
      }
      covered.add("skill");
    }
  }

  if (ctx.target) {
    actorOptions(ctx.target, "target", options);
    covered.add("target:type");
    covered.add("target:trait");
    covered.add("target:condition");
    if (typeof ctx.target.level === "number") covered.add("target:level");
  }

  if (ctx.action) {
    options.add(`action:${slug(ctx.action)}`);
    covered.add("action");
  }

  if (ctx.item) {
    const it = ctx.item;
    if (it.traits) {
      for (const t of it.traits) {
        options.add(`item:trait:${slug(t)}`);
        // Traço do item entra TAMBÉM solto: 955 predicados do dataset testam
        // `mental`/`fear`/`agile` sem prefixo nenhum.
        options.add(slug(t));
      }
      covered.add("item:trait");
      covered.add("trait");
    }
    if (it.type) {
      options.add(`item:type:${slug(it.type)}`);
      covered.add("item:type");
    }
    if (it.category) {
      options.add(`item:category:${slug(it.category)}`);
      covered.add("item:category");
    }
    if (it.base) {
      options.add(`item:base:${slug(it.base)}`);
      covered.add("item:base");
    }
    if (it.damageType) {
      options.add(`item:damage:type:${slug(it.damageType)}`);
      covered.add("item:damage:type");
    }
    if (it.name) {
      options.add(`item:slug:${slug(it.name)}`);
      covered.add("item:slug");
    }
    if (typeof it.rank === "number") {
      options.add(`item:rank:${it.rank}`);
      covered.add("item:rank");
    }
    if (typeof it.melee === "boolean") {
      if (it.melee) options.add("item:melee");
      covered.add("item:melee");
    }
    if (typeof it.ranged === "boolean") {
      if (it.ranged) options.add("item:ranged");
      covered.add("item:ranged");
    }
  }

  return { options, covered };
}

/**
 * O prefixo pelo qual um statement é julgado. Statement solto (sem `:`) cai em
 * `trait`, que é o que ele é na prática — traço do item/efeito em jogo.
 */
export function prefixOf(statement: string): string {
  const s = statement.trim();
  if (!s.includes(":")) return "trait";
  // Do prefixo mais específico para o mais geral: `item:damage:type` antes de
  // `item`, `self:condition` antes de `self`. Começa no statement INTEIRO
  // porque muitos são o próprio prefixo (`self:level` numa comparação gte).
  const parts = s.split(":");
  for (let n = parts.length; n >= 1; n--) {
    const candidate = parts.slice(0, n).join(":");
    if (
      (COVERABLE_PREFIXES as readonly string[]).includes(candidate) ||
      (DECLARED_UNCOVERED as readonly string[]).includes(candidate)
    ) {
      return candidate;
    }
  }
  // Nenhum prefixo conhecido: cai nos DOIS primeiros segmentos, não no
  // primeiro. `item:usage:hands:2` e `item:base:staff` são domínios distintos
  // que só têm o `item:` em comum — agrupá-los sob `item` inventaria um
  // domínio gigante onde há uma cauda de chaves de um feat só.
  return parts.length > 1 ? `${parts[0]}:${parts[1]}` : parts[0]!;
}

/**
 * Domínios cobertos só até uma PROFUNDIDADE de segmentos — mais fundo que isso
 * segue sendo dívida declarada, como se o prefixo inteiro estivesse em
 * `DECLARED_UNCOVERED`.
 *
 * `self:effect:rage` a engine decide (o registro lista os efeitos ativos);
 * `self:effect:overdrive-success:2` fala do *badge* — o contador do efeito no
 * Foundry —, que o registro não guarda. São 53 statements no dataset. Tratá-los
 * como cobertos os faria avaliar FALSO, e um `not:` em cima passaria a conceder
 * bônus onde a verdade é "não sei".
 */
export const PARTIAL_COVERAGE: Record<string, number> = { "self:effect": 3 };

/**
 * Este contexto consegue DECIDIR o statement? `false` significa "não sei" — o
 * avaliador (T3) tem de tratar como indecidível, nunca como falso.
 */
export function coversStatement(ro: RollOptions, statement: string): boolean {
  const s = statement.trim();
  const prefix = prefixOf(s);
  // Já afirmado: decidível por construção, seja qual for o prefixo.
  if (ro.options.has(s)) return true;
  const depth = PARTIAL_COVERAGE[prefix];
  if (depth !== undefined && s.split(":").length !== depth) return false;
  return ro.covered.has(prefix);
}
