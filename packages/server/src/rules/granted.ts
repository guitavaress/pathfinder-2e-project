/**
 * `GrantItem`: o que a ficha ganha SEM estar escrito nela.
 *
 * Um feat do PF2e frequentemente concede outro documento — `Innate Venom` dá a
 * ação `Envenom`, `Aquatic Adaptation` dá `Breath Control`, `Clan Dagger` dá
 * `Clan Pistol`. O Pathbuilder exporta só o que o jogador ESCOLHEU; o
 * concedido não aparece em lugar nenhum da ficha. Até aqui a engine ignorava
 * isso inteiramente: a ação concedida não existia para o sistema — nem custo,
 * nem rule element, nem desambiguação, nem paleta.
 *
 * MEDIDO (censo de 2026-08-16, 60 fichas geradas): `GrantItem` é a key sem
 * leitor que mais aparece em ficha real — **131 das 343 entradas cegas com
 * rule element (38,2%)**, e é a ÚNICA key de 59 delas. Nas categorias de ficha
 * há 1.208 ocorrências, das quais **992 resolvem** para um doc do dataset:
 * 550 feats, 371 ações, 41 condições, 19 equipamentos.
 *
 * O ganho é transitivo, e é daí que vem o tamanho: o doc concedido traz a
 * PRÓPRIA mecânica junto (rule elements, custo de ação, efeito auto-dirigido).
 * Resolver `GrantItem` não é ler mais uma key — é completar a ficha.
 *
 * O que este módulo NÃO faz, por escolha:
 *  - não aplica as 41 condições concedidas por maldição de divindade (isso é
 *    mudança de ESTADO, não de ficha, e precisa de um gatilho de jogo);
 *  - não inventa item no inventário para os 19 de equipamento (a quantidade e
 *    o investimento são do jogador, não do dado);
 *  - não resolve `ChoiceSet` — quando o grant depende de uma escolha que a
 *    ficha não registra, ele fica de fora e é DECLARADO, nunca adivinhado.
 */
import type { Character } from "@pf2e/shared";
import { byUuid, categoryRecords, lookupInCategory, type RuleRecord } from "./dataset.js";

/** Categorias cujos docs a ficha aponta diretamente. */
const SHEET_CATEGORIES = ["feats", "classes", "heritages", "ancestries", "backgrounds"] as const;

/** Categorias que fazem sentido ENTRAR na ficha por concessão. */
const GRANTABLE = new Set(["feats", "actions", "heritages", "classes"]);

/**
 * Profundidade máxima da cadeia de concessões.
 *
 * Concessão é transitiva (feat A dá feat B, que dá a ação C) e o dado tem
 * ciclos (`Clan Dagger` aparece concedendo a si mesmo em variantes). Sem teto e
 * sem guarda de visitados, isto é um laço infinito no meio de um turno.
 */
const MAX_DEPTH = 4;

export interface GrantedDoc {
  /** Nome do doc concedido, como no dataset. */
  name: string;
  category: string;
  /** Quem concedeu — a cadeia importa para explicar ao jogador. */
  via: string;
  /** 1 = concedido direto por um doc da ficha; 2+ = concedido por um concedido. */
  depth: number;
}

let index: Map<string, { uuid: string }[]> | null = null;

function normalize(s: string): string {
  return s.toLowerCase().trim();
}

/** Índice nome-do-doc → uuids que ele concede. */
function grantIndex(): Map<string, { uuid: string }[]> {
  if (index) return index;
  index = new Map();
  for (const cat of SHEET_CATEGORIES) {
    for (const rec of categoryRecords(cat)) {
      const grants: { uuid: string }[] = [];
      for (const raw of rec.rules ?? []) {
        const re = raw as Record<string, unknown>;
        if (re.key !== "GrantItem") continue;
        const uuid = typeof re.uuid === "string" ? re.uuid : "";
        // `uuid` com template (`{item|flags...}`) depende de ChoiceSet, que a
        // ficha não registra: fora, e o doc segue declarado como não resolvido.
        if (!uuid || uuid.includes("{")) continue;
        grants.push({ uuid });
      }
      if (grants.length) index.set(normalize(rec.name), grants);
    }
  }
  return index;
}

/** Os docs que a ficha aponta por nome, na ordem em que aparecem nela. */
function sheetDocs(c: Character): RuleRecord[] {
  const out: RuleRecord[] = [];
  const named: [string, string][] = [
    ...(c.feats ?? []).map((n) => [n, "feats"] as [string, string]),
    ...(c.classFeatures ?? []).map((n) => [n, "feats"] as [string, string]),
    ...(c.heritage ? [[c.heritage, "heritages"] as [string, string]] : []),
    ...(c.ancestry ? [[c.ancestry, "ancestries"] as [string, string]] : []),
    ...(c.className ? [[c.className, "classes"] as [string, string]] : []),
    ...(c.background ? [[c.background, "backgrounds"] as [string, string]] : []),
  ];
  for (const [name, cat] of named) {
    const rec = lookupInCategory(name, cat) ?? null;
    if (rec) out.push(rec);
  }
  return out;
}

/**
 * O fecho transitivo do que a ficha CONCEDE, sem o que ela já nomeia.
 *
 * Determinístico: a ordem sai da ordem da ficha, e nomes repetidos aparecem uma
 * vez só (o primeiro `via` vence). Um doc que a ficha já lista nunca entra —
 * senão ele contaria duas vezes em toda soma a jusante.
 */
export function grantedDocsFor(c: Character): GrantedDoc[] {
  const idx = grantIndex();
  const onSheet = new Set(
    [
      ...(c.feats ?? []),
      ...(c.classFeatures ?? []),
      c.heritage ?? "",
      c.ancestry ?? "",
      c.className ?? "",
      c.background ?? "",
    ]
      .filter(Boolean)
      .map(normalize),
  );

  const out: GrantedDoc[] = [];
  const seen = new Set<string>(onSheet);
  let frontier = sheetDocs(c).map((rec) => ({ rec, via: rec.name, depth: 0 }));

  for (let depth = 1; depth <= MAX_DEPTH && frontier.length; depth++) {
    const next: typeof frontier = [];
    for (const { rec, via } of frontier) {
      for (const { uuid } of idx.get(normalize(rec.name)) ?? []) {
        const target = byUuid(uuid);
        if (!target || !GRANTABLE.has(target.category)) continue;
        const key = normalize(target.name);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ name: target.name, category: target.category, via, depth });
        // A cadeia continua a partir do concedido, com o `via` ORIGINAL: para o
        // jogador, o que importa é qual escolha dele trouxe aquilo.
        next.push({ rec: target, via, depth });
      }
    }
    frontier = next;
  }
  return out;
}

/** Só os nomes — o formato que os consumidores de ficha já esperam. */
export function grantedNamesFor(c: Character): string[] {
  return grantedDocsFor(c).map((g) => g.name);
}

/** Só para teste: força a releitura do índice. */
export function resetGrantIndex(): void {
  index = null;
}
