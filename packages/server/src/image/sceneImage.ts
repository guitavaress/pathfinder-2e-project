/**
 * Cola da feature "Ilustrar cena" (espelho do brain.ts): fila single-flight,
 * diretório gitignorado servido como estático, e o fluxo por job:
 * destila (Gemma residente) → lms unload → ComfyUI gera → /free → lms load
 * em background. Fail-safe em camadas: flag desliga tudo, ComfyUI fora do ar
 * vira erro acionável, lms ausente segue sem swap.
 */
import { existsSync, mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { distillScenePrompt } from "../gm/agent.js";
import type { Session } from "../gm/sessions.js";
import { COMFY_DOWN_HINT, freeVram, isUp, submitAndWait } from "./comfy.js";
import { loadGm, unloadGm } from "./lms.js";
import {
  SceneImageQueue,
  type SceneImageJob,
  type SceneImagePhase,
  type SceneImageSnapshot,
} from "./queue.js";
import { parseLoras, STYLE_ANCHOR, zImageGraph } from "./workflow.js";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIR = join(here, "../../../../scene-images");

interface Job extends SceneImageJob {
  session: Session;
}

let queue: SceneImageQueue<Job> | null = null;

export function sceneImageEnabled(): boolean {
  return process.env.SCENE_IMAGE_DISABLED !== "1";
}

export function sceneImageDir(): string {
  const dir = process.env.SCENE_IMAGE_PATH ?? DEFAULT_DIR;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

async function runJob(
  job: Job,
  setPhase: (p: SceneImagePhase) => void,
): Promise<string> {
  if (!(await isUp())) throw new Error(COMFY_DOWN_HINT());

  // Destilação com o Gemma AINDA residente (é ele quem escreve o prompt).
  const distilled = await distillScenePrompt(job.session, job.narration);

  setPhase("generating");
  await unloadGm();
  try {
    const graph = zImageGraph({
      prompt: `${STYLE_ANCHOR} ${distilled}`,
      seed: Math.floor(Math.random() * 2 ** 32),
      loras: parseLoras(process.env.SCENE_IMAGE_LORAS),
    });
    const png = await submitAndWait(graph);
    const file = `${Date.now()}-${job.key.replace(/[^a-zA-Z0-9_-]/g, "")}.png`;
    await writeFile(join(sceneImageDir(), file), png);
    console.log(`[scene-image] gerada: ${file}`);
    return `/scene-images/${file}`;
  } finally {
    // Libera a VRAM do ComfyUI e recarrega o GM sem bloquear a resposta —
    // se o load falhar, o JIT do LM Studio resolve no próximo turno.
    await freeVram();
    void loadGm();
  }
}

/** Enfileira um job de imagem; false = clique repetido coalescido. */
export function queueSceneImage(
  session: Session,
  key: string,
  narration: string,
): boolean {
  if (!queue) {
    queue = new SceneImageQueue<Job>((job, setPhase) => runJob(job, setPhase));
  }
  return queue.push({ session, key, narration });
}

export function sceneImageStatus(): SceneImageSnapshot {
  return queue?.snapshot() ?? { phase: "idle" };
}
