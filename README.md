# pathfinder-2e-project

A **solo, web, local** RPG based on **Pathfinder 2e**, with an **AI-driven Game Master** running
**100% locally** (no API cost). You import a character built in
[Pathbuilder 2e](https://pathbuilder2e.com/), and the GM narrates a story driven entirely by your
decisions — with NPCs, a living world, and skill checks following the PF2e rules
([Archives of Nethys](https://2e.aonprd.com/)).

> **Status:** playable — import a character, play narrative scenes, and fight through a
> **deterministic PF2e combat engine**: initiative, the 3-action economy (activity costs read from
> the rules dataset), Multiple Attack Penalty, automatic damage with crits and Sneak Attack,
> conditions validated against the official list, activity Frequency and Requirements enforced,
> enemy turns resolved in code, item grounding with **real quantities** (`use_item` throws the bomb
> your sheet actually carries, with its real statblock), **named enemies with their official
> bestiary statblocks** (real AC/HP/saves/attacks, code-driven reactions like Reactive Strike,
> enemy spellcasters, persistent damage), real **rest rules** (overnight / Treat Wounds),
> **encounter difficulty enforced by the GM Core XP budget for your real party size** (solo play
> gets solo-sized encounters — the engine trims whatever the model over-declares), and full
> **dying/recovery rules** — you can actually die. Between sittings the game **remembers**: a
> markdown memory graph (the Brain) grows as you play, and **campaign continuity** lets you close
> the game mid-scene and pick up exactly where you left off, with a "Previously…" recap.
> Validated by a 75-scenario feat-audit regression battery (75/75 PASS) and 195 unit tests.

## How it works

The GM runs on **local models via [LM Studio](https://lmstudio.ai/)**, in a **two-stage pipeline**
per turn. By default **one model** drives both stages — each stage runs its own *context* (system
prompt + message thread), not its own model, so LM Studio keeps a single model resident and never
swaps weights mid-turn:

1. **Rules context** — resolves the PF2e mechanics with *tool use*: rolls checks and Strikes
   (`roll_check`), runs combat (`start_combat`/`end_combat`/`end_turn`/`spend_actions`), uses
   consumables from the sheet (`use_item`), casts spells with real slots and saves (`cast_spell`),
   rests with the real recovery rules (`rest`), looks up rules (`lookup_rule`), updates state
   (`update_state`), and produces a numbered mechanical summary. Dice, damage, action costs, conditions, and dying checks all come from **code**, not the
   model — the engine validates every tool input and rejects what the sheet can't support.
2. **Narrative context** — receives that summary and writes the immersive scene (streaming),
   consistent with the result. It calls no tools; what isn't in the summary didn't happen.

**Combat model:** one player message = one full turn (3 actions). The engine charges action costs
(reading activity costs from the rules dataset), applies damage automatically (crit doubles, Sneak
Attack vs off-guard), resolves every enemy's retaliation deterministically, and — when you drop to
0 HP — runs RAW dying/recovery checks until you stabilize (waking at 1 HP + wounded) or die at
dying 4. **Encounter difficulty is enforced in code**: the engine computes the GM Core XP budget
for the *real* party size (a solo character caps at 20 XP moderate / 40 XP extreme), trims
over-budget creatures before they enter play, never lets a creature above party level +4 join, and
counts defeated enemies toward the budget so "reinforcement waves" can't recreate a TPK. The web UI
shows a combat HUD (HP bars, action pips, MAP) and rich roll medallions.

The server talks to LM Studio through its **OpenAI-compatible API** (`http://localhost:1234/v1`).
Running the project inside **WSL with LM Studio on the Windows host** also works: start the Windows
server with network access (`lms server start --bind 0.0.0.0 --port 1234`) and point
`LMSTUDIO_BASE_URL` at the WSL default gateway (`ip route show default | awk '{print $3}'`).

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
├── shared/   # shared TS types (Character, GameState, Combat, CheckResult...)
├── brain/    # protagonist memory graph: markdown nodes + wikilinks, write-pass gates, graph view
├── server/   # Node/Express: REST API + GM agent (LM Studio) + combat engine + PF2e rules data
│   └── scripts/feat-audit/   # GM regression suite: 7039 feats classified + 75-scenario battery
└── web/      # React/Vite: import, sheet, narrative scene + combat HUD (streaming via SSE)
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
server loads them on demand.) If you already have a campaign going, the import screen shows a
**Continue campaign** card instead — one click resumes where you left off.

## Memory: the Brain

After each turn, a **write pass** lets the GM record what happened as a markdown knowledge graph in
`brain/` (gitignored — it's *your* story): one file per entity in `brain/nodes/` with typed
front-matter, a session-stamped `## Log`, and `## Connections` wikilinks; Journal, Timeline, and
Protagonist live at the root. Every command the model proposes goes through **gates in code**
(mention gate, name validation, node dedup, near-duplicate Timeline detection) — rejections are
auditable in the activity feed, never silent. The narrator reads relevant nodes back each turn, so
NPCs remember you. Press **B** in game to open the **Grimório da Memória**: a constellation graph
UI over the whole thing. Opt out with `BRAIN_DISABLED=1`; relocate with `BRAIN_PATH`.

## Campaign continuity

The server writes `brain/save.json` after every turn: character, state (HP, conditions, spell
slots, consumed items), and the recent narrative thread. Reopen the game and the **Continue
campaign** card restores all of it; the first turn then narrates a **deterministic "Previously…"
recap** — the engine assembles the facts (Timeline tail, open quests, the last scene) and the model
only narrates them, so the recap can't invent what didn't happen. Importing a new character starts
a **new campaign** and archives the current one to `brain-archive-<date>/` — nothing is ever
deleted. Session numbers count real sittings.

## Tests and build

```bash
npm test         # 195 unit tests: combat engine, dice/degrees, dying/recovery, encounter budget, use_item, spells, rest, brain graph + gates, save-game/recap, parser
npm run build
```

### GM regression battery (feat audit)

A reusable audit suite exercises the GM (model + engine) against real PF2e feats, grouped by
mechanical archetype, with hard assertions (action economy vs dataset cost, DC validity,
state-vs-narrative consistency). Uses the GPU/LM Studio while running:

```bash
cd packages/server
npx tsx scripts/feat-audit/classify-feats.ts   # classify all 7039 feats (combat × non-combat)
npx tsx scripts/feat-audit/run-feat-tests.ts   # run the 75-scenario battery (resumable)
#   filters: --side=combat|noncombat --archetype=<name> --feat="Name" --fresh
```

## License

MIT
