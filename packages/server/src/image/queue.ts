/**
 * Fila single-flight de geração de imagem (prima da WritePassQueue do brain):
 * um job por vez — LM Studio e ComfyUI disputam a mesma GPU. Cliques repetidos
 * na mesma narração enquanto o job roda são coalescidos (ignorados).
 * Diferença para a do brain: cada job tem status observável (a UI faz polling).
 */

export type SceneImagePhase = "idle" | "distilling" | "generating" | "done" | "error";

export interface SceneImageSnapshot {
  phase: SceneImagePhase;
  /** URL pública do PNG quando phase === "done". */
  url?: string;
  error?: string;
  /** Identifica a narração do job atual/último (a UI casa imagem ↔ mensagem). */
  jobKey?: string;
  startedAt?: number;
}

export interface SceneImageJob {
  /** Chave estável da narração (a UI usa o índice da linha do log). */
  key: string;
  narration: string;
}

export class SceneImageQueue<J extends SceneImageJob = SceneImageJob> {
  private pending: J[] = [];
  private running = false;
  private snap: SceneImageSnapshot = { phase: "idle" };

  constructor(
    private readonly run: (
      job: J,
      setPhase: (phase: SceneImagePhase) => void,
    ) => Promise<string>,
  ) {}

  /** Enfileira; false se um job igual já roda/aguarda (clique repetido). */
  push(job: J): boolean {
    const duplicate =
      this.pending.some((j) => j.key === job.key) ||
      (this.running && this.snap.jobKey === job.key && this.snap.phase !== "done" && this.snap.phase !== "error");
    if (duplicate) return false;
    this.pending.push(job);
    void this.drain();
    return true;
  }

  get busy(): boolean {
    return this.running || this.pending.length > 0;
  }

  snapshot(): SceneImageSnapshot {
    return { ...this.snap };
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length > 0) {
        const job = this.pending.shift()!;
        this.snap = { phase: "distilling", jobKey: job.key, startedAt: Date.now() };
        try {
          const url = await this.run(job, (phase) => {
            this.snap = { ...this.snap, phase };
          });
          this.snap = { ...this.snap, phase: "done", url };
        } catch (err) {
          this.snap = {
            ...this.snap,
            phase: "error",
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
    } finally {
      this.running = false;
    }
  }
}
