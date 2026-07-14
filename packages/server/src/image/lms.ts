/**
 * Swap de VRAM em volta da geração: a 4070 (12 GB) não comporta o Gemma
 * residente + Z-Image ao mesmo tempo. Descarrega o modelo do GM via CLI do
 * LM Studio antes de gerar e recarrega depois (em background). Tudo fail-safe:
 * sem `lms`, a geração segue — o ComfyUI tenta se virar com a VRAM que houver.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

const DEFAULT_LMS = "/mnt/c/Users/gui_t/.lmstudio/bin/lms.exe";

function lmsPath(): string | null {
  const p = process.env.LMS_EXE ?? DEFAULT_LMS;
  return existsSync(p) ? p : null;
}

function gmModel(): string {
  return process.env.GM_MODEL ?? "gemma-4-12b-it";
}

async function lms(args: string[]): Promise<boolean> {
  const exe = lmsPath();
  if (!exe) {
    console.warn("[scene-image] lms não encontrado (LMS_EXE) — geração sem swap de VRAM");
    return false;
  }
  try {
    await execFileP(exe, args, { timeout: 120_000 });
    return true;
  } catch (err) {
    console.warn(
      `[scene-image] lms ${args[0]} falhou:`,
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/** Descarrega o modelo do GM para liberar VRAM para a geração. */
export async function unloadGm(): Promise<boolean> {
  return lms(["unload", gmModel()]);
}

/**
 * Recarrega o modelo do GM (contexto igual ao do jogo). Chamado sem await ao
 * fim do job — se falhar, o JIT do LM Studio recarrega no próximo turno.
 */
export async function loadGm(): Promise<boolean> {
  const ctx = process.env.LMS_CONTEXT ?? "8192";
  return lms(["load", gmModel(), "--context-length", ctx]);
}
