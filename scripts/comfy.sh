#!/usr/bin/env bash
# Sobe o ComfyUI headless para a feature "Ilustrar cena" (porta 8188).
# Instalação esperada em ~/ComfyUI (venv próprio + modelos em models/):
#   - models/unet/z-image-turbo-Q8_0.gguf
#   - models/text_encoders/qwen_3_4b.safetensors
#   - models/vae/z_image_ae.safetensors
set -euo pipefail

COMFY_DIR="${COMFY_DIR:-$HOME/ComfyUI}"
COMFY_PORT="${COMFY_PORT:-8188}"

if [[ ! -f "$COMFY_DIR/main.py" ]]; then
  echo "ComfyUI não encontrado em $COMFY_DIR (defina COMFY_DIR se estiver noutro lugar)." >&2
  exit 1
fi
if [[ ! -f "$COMFY_DIR/venv/bin/activate" ]]; then
  echo "venv não encontrado em $COMFY_DIR/venv." >&2
  exit 1
fi
if [[ ! -f "$COMFY_DIR/models/unet/z-image-turbo-Q8_0.gguf" ]]; then
  echo "Aviso: z-image-turbo-Q8_0.gguf não encontrado em $COMFY_DIR/models/unet — a geração vai falhar." >&2
fi

source "$COMFY_DIR/venv/bin/activate"
cd "$COMFY_DIR"
exec python main.py --listen 127.0.0.1 --port "$COMFY_PORT" --disable-auto-launch
