/**
 * Toda rota do server precisa estar no proxy do dev server.
 *
 * Este teste nasce de um bug real da Fase 2.7: a rota `/palette` entrou no
 * Express e NÃO entrou no `vite.config.ts`. Em produção tudo funcionava (mesma
 * origem); no `npm run dev` o Vite respondia o `index.html` com **200 OK**, o
 * cliente lia um JSON que não era JSON e a paleta do `@` ficava vazia — sem
 * erro, sem log, sem sintoma além de "os botões não aparecem".
 *
 * É a falha mais cara que existe: silenciosa e só no ambiente onde se joga.
 * Rota nova sem proxy agora quebra aqui, não no play-test.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const serverSrc = readFileSync(join(here, "server.ts"), "utf8");
const viteConfig = readFileSync(
  join(here, "../../../web/vite.config.ts"),
  "utf8",
);

/** Primeiro segmento de cada rota registrada no Express (`/palette/:id` → `/palette`). */
function routePrefixes(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(/app\.(?:get|post|put|patch|delete)\(\s*"(\/[^"?]*)"/g)) {
    const first = m[1]!.split("/")[1];
    if (first) out.add(`/${first}`);
  }
  return out;
}

/** Chaves declaradas no bloco `proxy: { ... }` do vite.config.ts. */
function proxiedPrefixes(source: string): Set<string> {
  const block = source.slice(source.indexOf("proxy: {"));
  const out = new Set<string>();
  for (const m of block.matchAll(/"(\/[a-zA-Z0-9_-]+)"\s*:/g)) out.add(m[1]!);
  return out;
}

describe("rotas do server × proxy do dev server", () => {
  it("encontra as rotas e o bloco de proxy (guarda contra regex que parou de casar)", () => {
    expect(routePrefixes(serverSrc).size).toBeGreaterThan(3);
    expect(proxiedPrefixes(viteConfig).size).toBeGreaterThan(3);
  });

  it("toda rota do Express é encaminhada pelo vite.config.ts", () => {
    const proxied = proxiedPrefixes(viteConfig);
    const missing = [...routePrefixes(serverSrc)].filter((p) => !proxied.has(p));
    expect(
      missing,
      `rota(s) fora do proxy do dev server: ${missing.join(", ")} — ` +
        "adicione em packages/web/vite.config.ts, senão o Vite devolve o " +
        "index.html com 200 e o cliente falha em silêncio",
    ).toEqual([]);
  });
});
