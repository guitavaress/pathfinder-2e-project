/**
 * Cliente HTTP mínimo do ComfyUI (fetch nativo do Node 20). O ComfyUI é um
 * serviço manual (`npm run comfy`, porta 8188); tudo aqui falha com mensagem
 * acionável em vez de stack críptico.
 */

function baseUrl(): string {
  return (process.env.COMFYUI_URL ?? "http://127.0.0.1:8188").replace(/\/$/, "");
}

export const COMFY_DOWN_HINT = () =>
  `ComfyUI não respondeu em ${baseUrl()} — suba com \`npm run comfy\`.`;

/** ComfyUI está de pé? (timeout curto — usado antes de aceitar o job). */
export async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl()}/system_stats`, {
      signal: AbortSignal.timeout(2_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

interface HistoryEntry {
  status?: { status_str?: string; completed?: boolean };
  outputs?: Record<string, { images?: { filename: string; subfolder: string; type: string }[] }>;
}

/** Extrai a mensagem de erro de um history entry com status "error". */
export function historyError(entry: HistoryEntry): string {
  const messages = (entry.status as { messages?: unknown[] } | undefined)?.messages ?? [];
  for (const m of messages) {
    if (Array.isArray(m) && m[0] === "execution_error") {
      const detail = m[1] as { node_type?: string; exception_message?: string };
      return `${detail.node_type ?? "?"}: ${(detail.exception_message ?? "").trim()}`;
    }
  }
  return "erro desconhecido do ComfyUI";
}

/** Primeira imagem de um history entry concluído (ou null). */
export function firstImage(
  entry: HistoryEntry,
): { filename: string; subfolder: string; type: string } | null {
  for (const out of Object.values(entry.outputs ?? {})) {
    const img = out.images?.[0];
    if (img) return img;
  }
  return null;
}

/**
 * Envia o grafo, espera concluir e devolve os bytes do PNG (via GET /view —
 * sem depender do diretório output/ do ComfyUI, que mora fora do repo).
 */
export async function submitAndWait(
  graph: Record<string, unknown>,
  timeoutMs = 240_000,
): Promise<Buffer> {
  const submit = await fetch(`${baseUrl()}/prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: graph }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!submit.ok) {
    const body = await submit.text().catch(() => "");
    throw new Error(`ComfyUI rejeitou o grafo (${submit.status}): ${body.slice(0, 400)}`);
  }
  const { prompt_id } = (await submit.json()) as { prompt_id: string };

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1_000));
    const res = await fetch(`${baseUrl()}/history/${prompt_id}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) continue;
    const hist = (await res.json()) as Record<string, HistoryEntry>;
    const entry = hist[prompt_id];
    if (!entry) continue;
    if (entry.status?.status_str === "error") {
      throw new Error(`geração falhou — ${historyError(entry)}`);
    }
    if (entry.status?.completed || entry.outputs) {
      const img = firstImage(entry);
      if (!img) throw new Error("geração concluiu sem imagem no output");
      const view = await fetch(
        `${baseUrl()}/view?filename=${encodeURIComponent(img.filename)}` +
          `&subfolder=${encodeURIComponent(img.subfolder)}&type=${img.type}`,
        { signal: AbortSignal.timeout(30_000) },
      );
      if (!view.ok) throw new Error(`GET /view falhou (${view.status})`);
      return Buffer.from(await view.arrayBuffer());
    }
  }
  throw new Error(`geração excedeu ${Math.round(timeoutMs / 1000)}s`);
}

/** Libera a VRAM do ComfyUI (modelos ficam no page cache; recarga é rápida). */
export async function freeVram(): Promise<void> {
  try {
    await fetch(`${baseUrl()}/free`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // fail-safe: VRAM presa até o próximo /free ou restart do ComfyUI — não é fatal.
  }
}
