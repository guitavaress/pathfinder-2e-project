/**
 * Nome do diretório para onde a campanha atual é arquivada quando um import
 * começa uma campanha nova. Arquivar NUNCA apaga — é a garantia do PR #11.
 */
import { existsSync } from "node:fs";

/**
 * `<dir>-archive-<AAAAMMDD-hhmm>`, com sufixo incremental quando o nome já
 * está ocupado.
 *
 * Por que o sufixo: o stamp tem resolução de MINUTO e `renameSync` estoura
 * `ENOTEMPTY` se o destino já existe e não está vazio. Dois imports no mesmo
 * minuto derrubavam o import com 400 — e derrubaram a bateria feat-audit
 * inteira (importa um personagem por cenário, ~25-35s cada) do 2º cenário em
 * diante, descoberto em 2026-07-24. Subir o stamp para segundos só empurraria a
 * colisão; o que remove a classe de erro é conferir se o destino está livre.
 */
export function archiveDestination(
  dir: string,
  now: Date = new Date(),
  exists: (path: string) => boolean = existsSync,
): string {
  const stamp = now
    .toISOString()
    .slice(0, 16)
    .replace(/[-:T]/g, "")
    .replace(/^(\d{8})/, "$1-");
  const base = `${dir}-archive-${stamp}`;
  if (!exists(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!exists(candidate)) return candidate;
  }
  throw new Error(`Sem nome livre para arquivar a campanha em ${base}-*`);
}
