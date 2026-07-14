import { describe, expect, it } from "vitest";
import { firstImage, historyError } from "./comfy.js";

// Fixture real da bateria de 2026-07-13: Flux2Scheduler recebeu input inexistente.
const ERROR_ENTRY = {
  status: {
    status_str: "error",
    completed: false,
    messages: [
      ["execution_start", { prompt_id: "b1f6" }],
      ["execution_cached", { nodes: [] }],
      [
        "execution_error",
        {
          node_id: "9",
          node_type: "Flux2Scheduler",
          exception_message: "Flux2Scheduler.execute() got an unexpected keyword argument 'model'\n",
        },
      ],
    ],
  },
} as never;

const SUCCESS_ENTRY = {
  status: { status_str: "success", completed: true },
  outputs: {
    "10": {
      images: [{ filename: "scene_00001_.png", subfolder: "", type: "output" }],
    },
  },
} as never;

describe("historyError", () => {
  it("extrai node e mensagem do execution_error", () => {
    expect(historyError(ERROR_ENTRY)).toBe(
      "Flux2Scheduler: Flux2Scheduler.execute() got an unexpected keyword argument 'model'",
    );
  });
  it("fallback para status sem execution_error", () => {
    expect(historyError({ status: { status_str: "error" } } as never)).toBe(
      "erro desconhecido do ComfyUI",
    );
  });
});

describe("firstImage", () => {
  it("acha a primeira imagem nos outputs", () => {
    expect(firstImage(SUCCESS_ENTRY)).toMatchObject({ filename: "scene_00001_.png" });
  });
  it("null quando o entry não tem imagem", () => {
    expect(firstImage({ outputs: { "10": {} } } as never)).toBeNull();
    expect(firstImage({} as never)).toBeNull();
  });
});
