/**
 * Builder puro do grafo API do ComfyUI para o Z-Image Turbo (Q8 GGUF).
 * Parâmetros validados na bateria A/B de 2026-07-13 (workflow oficial do
 * template do ComfyUI): 8 steps, cfg 1, res_multistep/simple, AuraFlow shift 3,
 * encoder Qwen3-4B carregado com type "lumina2".
 *
 * A âncora de estilo mora AQUI (engine garante): o modelo de destilação só
 * descreve a cena; o estilo visual do jogo é constante e vem de código.
 */

export const STYLE_ANCHOR =
  "Dark fantasy oil painting, dramatic chiaroscuro lighting, muted earthy " +
  "palette with deep shadows, painterly brushwork, cinematic composition, " +
  "in the style of a Pathfinder rulebook illustration.";

export const UNET_FILE = "z-image-turbo-Q8_0.gguf";
export const ENCODER_FILE = "qwen_3_4b.safetensors";
export const VAE_FILE = "z_image_ae.safetensors";

export interface LoraSpec {
  name: string;
  strength: number;
}

/** Parse de SCENE_IMAGE_LORAS ("arquivo.safetensors:0.8,outro:0.6"). */
export function parseLoras(raw: string | undefined): LoraSpec[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .flatMap((entry) => {
      const idx = entry.lastIndexOf(":");
      const name = idx > 0 ? entry.slice(0, idx).trim() : entry;
      const strength = idx > 0 ? Number(entry.slice(idx + 1)) : 1;
      if (!name || !Number.isFinite(strength)) return [];
      return [{ name, strength }];
    });
}

export interface ZImageGraphOptions {
  /** Prompt visual completo (âncora de estilo + cena destilada). */
  prompt: string;
  seed: number;
  loras?: LoraSpec[];
  filenamePrefix?: string;
}

type ComfyNode = { class_type: string; inputs: Record<string, unknown> };

/** Grafo API-format pronto para POST /prompt. */
export function zImageGraph(opts: ZImageGraphOptions): Record<string, ComfyNode> {
  const loras = opts.loras ?? [];
  const graph: Record<string, ComfyNode> = {
    "1": { class_type: "UnetLoaderGGUF", inputs: { unet_name: UNET_FILE } },
    "2": {
      class_type: "CLIPLoader",
      inputs: { clip_name: ENCODER_FILE, type: "lumina2", device: "default" },
    },
    "3": { class_type: "VAELoader", inputs: { vae_name: VAE_FILE } },
  };

  // Cadeia opcional de LoRAs (model-only; o encoder é um LLM, não recebe LoRA).
  let model: [string, number] = ["1", 0];
  loras.forEach((lora, i) => {
    const id = `lora${i}`;
    graph[id] = {
      class_type: "LoraLoaderModelOnly",
      inputs: { model, lora_name: lora.name, strength_model: lora.strength },
    };
    model = [id, 0];
  });

  graph["4"] = {
    class_type: "ModelSamplingAuraFlow",
    inputs: { shift: 3, model },
  };
  graph["5"] = {
    class_type: "CLIPTextEncode",
    inputs: { text: opts.prompt, clip: ["2", 0] },
  };
  graph["6"] = { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["2", 0] } };
  graph["7"] = {
    class_type: "EmptySD3LatentImage",
    inputs: { width: 1024, height: 1024, batch_size: 1 },
  };
  graph["8"] = {
    class_type: "KSampler",
    inputs: {
      model: ["4", 0],
      seed: opts.seed,
      steps: 8,
      cfg: 1.0,
      sampler_name: "res_multistep",
      scheduler: "simple",
      denoise: 1.0,
      positive: ["5", 0],
      negative: ["6", 0],
      latent_image: ["7", 0],
    },
  };
  graph["9"] = { class_type: "VAEDecode", inputs: { samples: ["8", 0], vae: ["3", 0] } };
  graph["10"] = {
    class_type: "SaveImage",
    inputs: { images: ["9", 0], filename_prefix: opts.filenamePrefix ?? "scene" },
  };
  return graph;
}
