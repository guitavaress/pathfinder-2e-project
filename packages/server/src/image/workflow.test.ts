import { describe, expect, it } from "vitest";
import { parseLoras, STYLE_ANCHOR, zImageGraph } from "./workflow.js";

describe("zImageGraph", () => {
  it("monta o grafo com os parâmetros validados na bateria", () => {
    const g = zImageGraph({ prompt: `${STYLE_ANCHOR} A dark tunnel.`, seed: 42 });
    expect(g["1"].class_type).toBe("UnetLoaderGGUF");
    expect(g["2"].inputs).toMatchObject({ clip_name: "qwen_3_4b.safetensors", type: "lumina2" });
    expect(g["4"]).toMatchObject({
      class_type: "ModelSamplingAuraFlow",
      inputs: { shift: 3, model: ["1", 0] },
    });
    expect(g["8"].inputs).toMatchObject({
      steps: 8,
      cfg: 1.0,
      sampler_name: "res_multistep",
      scheduler: "simple",
      seed: 42,
    });
    expect(String(g["5"].inputs.text)).toContain(STYLE_ANCHOR);
  });

  it("injeta a cadeia de LoRAs entre o UNET e o sampler", () => {
    const g = zImageGraph({
      prompt: "x",
      seed: 1,
      loras: [
        { name: "style.safetensors", strength: 0.8 },
        { name: "char.safetensors", strength: 0.6 },
      ],
    });
    expect(g["lora0"].inputs).toMatchObject({
      model: ["1", 0],
      lora_name: "style.safetensors",
      strength_model: 0.8,
    });
    expect(g["lora1"].inputs.model).toEqual(["lora0", 0]);
    // O sampler consome o fim da cadeia, não o UNET cru.
    expect(g["4"].inputs.model).toEqual(["lora1", 0]);
  });

  it("sem LoRAs o sampler consome o UNET direto", () => {
    const g = zImageGraph({ prompt: "x", seed: 1, loras: [] });
    expect(g["4"].inputs.model).toEqual(["1", 0]);
    expect(Object.keys(g).some((k) => k.startsWith("lora"))).toBe(false);
  });
});

describe("parseLoras", () => {
  it("parseia nome:força separados por vírgula", () => {
    expect(parseLoras("a.safetensors:0.8, b.safetensors:0.6")).toEqual([
      { name: "a.safetensors", strength: 0.8 },
      { name: "b.safetensors", strength: 0.6 },
    ]);
  });
  it("força default 1 quando omitida", () => {
    expect(parseLoras("a.safetensors")).toEqual([{ name: "a.safetensors", strength: 1 }]);
  });
  it("descarta entradas inválidas em vez de fabricar default silencioso", () => {
    expect(parseLoras("a.safetensors:abc")).toEqual([]);
    expect(parseLoras(undefined)).toEqual([]);
    expect(parseLoras("  ,, ")).toEqual([]);
  });
});
