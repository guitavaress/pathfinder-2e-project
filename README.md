# pathfinder-2e-project

A **solo, web, local** RPG based on **Pathfinder 2e**, with an **AI-driven Game Master** running
**100% locally** (no API cost). You import a character built in
[Pathbuilder 2e](https://pathbuilder2e.com/), and the GM narrates a story driven entirely by your
decisions — with NPCs, a living world, and skill checks following the PF2e rules
([Archives of Nethys](https://2e.aonprd.com/)).

> **Status:** MVP — import a character, view the sheet, and play a **narrative scene** with NPCs and
> skill checks. A full tactical combat engine will come in later phases.

## How it works

The GM runs on **local models via [LM Studio](https://lmstudio.ai/)**, in a **two-stage pipeline**
per turn. By default **one model** drives both stages — each stage runs its own *context* (system
prompt + message thread), not its own model, so LM Studio keeps a single model resident and never
swaps weights mid-turn:

1. **Rules context** — resolves the PF2e mechanics with *tool use*: picks the check/DC, rolls dice
   (`roll_check`), looks up rules (`lookup_rule`), updates state (`update_state`), and produces a
   mechanical summary. This prevents "hallucinated" rolls (the dice come from code, not the model).
2. **Narrative context** — receives that summary and writes the immersive scene (streaming),
   consistent with the result. It calls no tools.

The server talks to LM Studio through its **OpenAI-compatible API** (`http://localhost:1234/v1`).

- **Default (`GM_MODEL`):** one model for both stages — `google/gemma-4-12b`
  (Gemma 4 12B, official, Q4). It fits entirely in ~12 GB VRAM (no CPU offload) and follows
  instructions well. No per-turn model swap.
  ⚠️ Its native context is huge (256K); keep the LM Studio **Context Length** modest (e.g. 16k–32k) so
  the KV cache fits alongside the weights on 12 GB. Confirm the exact model key with `lms ls`.
- **Two-model mode (opt-in):** set `RULES_MODEL` and `NARRATIVE_MODEL` to different models for
  specialization (e.g. a stronger narrator). Needs enough VRAM for both to stay resident, otherwise
  LM Studio swaps weights each turn (minutes/turn on ~12 GB).
- **Inference cost:** zero — everything runs on your machine.

## Structure

```
packages/
├── shared/   # shared TS types (Character, GameState, CheckResult...)
├── server/   # Node/Express: REST API + GM agent (LM Studio) + data + PF2e rules
└── web/      # React/Vite: import, sheet, and narrative scene (streaming via SSE)
```

## Requirements

- Node.js 20+
- [LM Studio](https://lmstudio.ai/) installed, with its local server running (`lms server start`)
- NVIDIA GPU: a model that fully fits in ~12 GB runs smoothly; the default
  `google/gemma-4-12b` (Gemma 4 12B, Q4) fits entirely on 12 GB
  (keep the context modest). Two-model mode needs enough VRAM for both models to stay resident.

## Setup

```bash
# 1. Install LM Studio (https://lmstudio.ai/download), start its server, and download the model
lms server start
lms get google/gemma-4-12b   # GM_MODEL (drives both stages); then `lms ls` to confirm the exact key
# Optional two-model mode: also `lms get google/gemma-3-27b` and set NARRATIVE_MODEL

# 2. Project dependencies
npm install
cp .env.example .env   # adjust GM_MODEL / LMSTUDIO_BASE_URL (RULES/NARRATIVE_MODEL optional)

# 3. PF2e rules dataset (local index the GM consults)
#    Downloads the dataset from the foundryvtt/pf2e repo (~26k entries: actions, feats,
#    spells, conditions, items, bestiary). Requires git. Version via PF2E_GIT_REF.
npm run data:pf2e
#    Alternative: read from your local Foundry install (close Foundry first):
#    npm run data:pf2e -- --from-local      # uses PF2E_SYSTEM_PATH
```

> The generated dataset lives in `packages/server/data/pf2e/generated/` (gitignored — not
> redistributed). Before running `data:pf2e`, the GM uses a small seed dataset.

### World / setting

The world is split into **two layers**, both injected into the GM prompt and both **gitignored**
(kept local, out of the public repo):

- Copy `WORLD.example.md` to **`WORLD.md`** — the **player-facing** surface world plus an authored
  **`## Opening scene`**. This is what the GM may reveal naturally, and what the opening turn narrates
  (so the GM starts small and mundane instead of improvising from secrets). Path via `WORLD_PATH`.
- Copy `LORE.example.md` to **`LORE.md`** — the **GM-only secrets** (spoilers/hidden truth). The GM
  uses these only to plant subtle hints and **never reveals or dumps them**. Path via `LORE_PATH`.

Both are optional: without them the game runs with no specific setting.

## Running

In two terminals:

```bash
npm run dev:server   # GM backend at http://localhost:3001
npm run dev:web      # frontend at http://localhost:5173
```

Open `http://localhost:5173`, import `exemplo_personagem.json` (a level 5 Goblin Rogue) or your own
Pathbuilder 2e export, and start playing. (LM Studio must be running with the models downloaded; the
server loads them on demand.)

## Tests and build

```bash
npm test     # Pathbuilder parser + dice/degree-of-success tests
npm run build
```

## License

MIT
