/**
 * Avaliador de predicados de rule element.
 *
 * 48% dos rule elements do dataset têm predicado; sem avaliá-los esses ~8.000
 * ficam inalcançáveis. A gramática inteira, MEDIDA no dataset, são 9
 * operadores: `or` (1.570), `and` (445), `not` (641), `gte` (322), `lte` (80),
 * `nor` (56), `gt` (34), `lt` (27), `nand` (3). O predicado no topo é sempre um
 * array — conjunção implícita (7.948 de 7.948).
 *
 * A lógica é de TRÊS valores, não dois. `roll-options.ts` distingue "o
 * contexto afirma que não" de "o contexto não sabe", e essa distinção tem de
 * sobreviver ao aninhamento: `not:` sobre algo indecidível continua
 * indecidível, nunca vira verdadeiro. Colapsar unknown em false aqui traria de
 * volta, por outro caminho, o bug que a T2 existe para evitar.
 *
 * Forma fora da gramática nunca vira verdadeiro: fica registrada em
 * `malformed` e o resultado é indecidível.
 */
import { coversStatement, type RollOptions } from "./roll-options.js";

/** Lógica de Kleene: o terceiro valor é "o contexto não sabe". */
export type Truth = "true" | "false" | "unknown";

export interface PredicateEvaluation {
  value: Truth;
  /** Statements que este contexto não consegue decidir. */
  undecided: string[];
  /** Formas sintáticas não reconhecidas — dívida visível, não silenciosa. */
  malformed: string[];
}

const LOGIC_OPS = new Set(["or", "and", "nor", "nand", "not"]);
const COMPARE_OPS = new Set(["gte", "lte", "gt", "lt", "eq"]);

interface Acc {
  undecided: string[];
  malformed: string[];
}

/** Conjunção de Kleene: um falso derruba tudo; senão, unknown contamina. */
function allOf(values: Truth[]): Truth {
  if (values.includes("false")) return "false";
  if (values.includes("unknown")) return "unknown";
  return "true";
}

/** Disjunção de Kleene: um verdadeiro basta; senão, unknown contamina. */
function anyOf(values: Truth[]): Truth {
  if (values.includes("true")) return "true";
  if (values.includes("unknown")) return "unknown";
  return "false";
}

function negate(v: Truth): Truth {
  return v === "true" ? "false" : v === "false" ? "true" : "unknown";
}

/**
 * Valor numérico de uma chave de opção. Convenção do pf2e: a opção
 * `self:level:5` afirma que a chave `self:level` vale 5.
 *
 * O terceiro caso é o que importa: chave ausente num domínio COBERTO significa
 * quantidade ausente (comparação falsa, como no Foundry); num domínio não
 * coberto significa que não sabemos.
 */
function numericValue(
  key: string,
  ro: RollOptions,
): { kind: "value"; value: number } | { kind: "absent" } | { kind: "unknown" } {
  let best: number | null = null;
  const prefix = `${key}:`;
  for (const opt of ro.options) {
    if (!opt.startsWith(prefix)) continue;
    const tail = opt.slice(prefix.length);
    if (!/^-?\d+$/.test(tail)) continue;
    const n = Number(tail);
    if (best === null || n > best) best = n;
  }
  if (best !== null) return { kind: "value", value: best };
  return coversStatement(ro, key) ? { kind: "absent" } : { kind: "unknown" };
}

/** Um lado da comparação: número literal ou chave de opção a resolver. */
function operand(
  raw: unknown,
  ro: RollOptions,
  acc: Acc,
): { kind: "value"; value: number } | { kind: "absent" } | { kind: "unknown" } {
  if (typeof raw === "number" && Number.isFinite(raw)) return { kind: "value", value: raw };
  if (typeof raw === "string") {
    const resolved = numericValue(raw, ro);
    if (resolved.kind === "unknown") acc.undecided.push(raw);
    return resolved;
  }
  acc.malformed.push(JSON.stringify(raw));
  return { kind: "unknown" };
}

function compare(op: string, left: number, right: number): boolean {
  switch (op) {
    case "gte":
      return left >= right;
    case "lte":
      return left <= right;
    case "gt":
      return left > right;
    case "lt":
      return left < right;
    case "eq":
      return left === right;
    default:
      return false;
  }
}

function evalNode(node: unknown, ro: RollOptions, acc: Acc): Truth {
  // Array = conjunção implícita (é a forma do predicado no topo).
  if (Array.isArray(node)) {
    return allOf(node.map((n) => evalNode(n, ro, acc)));
  }

  // Statement simples: presença no conjunto de roll options.
  if (typeof node === "string") {
    const s = node.trim();
    if (ro.options.has(s)) return "true";
    if (coversStatement(ro, s)) return "false";
    acc.undecided.push(s);
    return "unknown";
  }

  if (node === null || typeof node !== "object") {
    acc.malformed.push(JSON.stringify(node));
    return "unknown";
  }

  const keys = Object.keys(node as Record<string, unknown>);
  // Medido: nenhum objeto do dataset tem 2 chaves. Se aparecer, a semântica é
  // ambígua — e ambiguidade não vira verdadeiro.
  if (keys.length !== 1) {
    acc.malformed.push(JSON.stringify(node).slice(0, 120));
    return "unknown";
  }

  const op = keys[0]!;
  const value = (node as Record<string, unknown>)[op];

  if (LOGIC_OPS.has(op)) {
    if (op === "not") return negate(evalNode(value, ro, acc));
    if (!Array.isArray(value)) {
      acc.malformed.push(`${op} sem array`);
      return "unknown";
    }
    const inner = value.map((n) => evalNode(n, ro, acc));
    if (op === "or") return anyOf(inner);
    if (op === "and") return allOf(inner);
    if (op === "nor") return negate(anyOf(inner));
    return negate(allOf(inner)); // nand
  }

  if (COMPARE_OPS.has(op)) {
    if (!Array.isArray(value) || value.length !== 2) {
      acc.malformed.push(`${op} sem par de operandos`);
      return "unknown";
    }
    const left = operand(value[0], ro, acc);
    const right = operand(value[1], ro, acc);
    if (left.kind === "unknown" || right.kind === "unknown") return "unknown";
    // Quantidade ausente num domínio conhecido: a comparação simplesmente não
    // se sustenta (mesmo comportamento do pf2e no Foundry).
    if (left.kind === "absent" || right.kind === "absent") return "false";
    return compare(op, left.value, right.value) ? "true" : "false";
  }

  acc.malformed.push(op);
  return "unknown";
}

/** Avalia um predicado de rule element contra as roll options do momento. */
export function evaluate(predicate: unknown, ro: RollOptions): PredicateEvaluation {
  const acc: Acc = { undecided: [], malformed: [] };
  // Predicado ausente = sem condição. 52% dos rule elements caem aqui.
  if (predicate == null) return { value: "true", undecided: [], malformed: [] };
  const value = evalNode(predicate, ro, acc);
  return { value, undecided: acc.undecided, malformed: acc.malformed };
}

/**
 * O portão que a engine usa: aplica o rule element SÓ quando o predicado é
 * seguramente verdadeiro. Indecidível não aplica — mas quem quiser saber por
 * que não aplicou tem `evaluate` com `undecided`/`malformed`.
 */
export function isSatisfied(predicate: unknown, ro: RollOptions): boolean {
  return evaluate(predicate, ro).value === "true";
}
