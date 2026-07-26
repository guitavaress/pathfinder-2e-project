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
> You can also travel with **NPC companions**: the engine runs their combat turns, and a voice
> gate lets at most one of them speak per turn so their personalities stay distinct.
> Validated by a 75-scenario feat-audit regression battery and 393 unit tests.

## How it works

The GM runs on a **local model served by [llama.cpp](https://github.com/ggml-org/llama.cpp)**, in a
**two-stage pipeline** per turn. **One model** drives both stages — each stage runs its own *context*
(system prompt + message thread), not its own model, so a single set of weights stays resident and
nothing is swapped mid-turn:

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

The server talks to `llama-server` through its **OpenAI-compatible API**, at `LLM_BASE_URL`
(default `http://127.0.0.1:1234/v1`). Any OpenAI-compatible local server works (LM Studio, Ollama);
only two things are actually required:

- **`--jinja`** — tool calling lives or dies on it, and the whole rules stage is tool calling.
- **Enough context.** Both stages sit around 7k tokens of fixed prompt before any history
  (rules: system + the tool schemas; narrative: system + setting + lore + sheet + memory), so a
  16k window is the practical floor and 64k gives the history windows room to breathe.

> **WSL note:** prefer `127.0.0.1` over `localhost` in `LLM_BASE_URL`. `llama-server` binds IPv4
> only unless told otherwise, and on WSL2 `localhost` resolves to IPv6 `::1` first.

- **Default (`GM_MODEL`):** one model for both stages — Gemma 4 12B (Q4). It fits entirely in
  ~12 GB VRAM (no CPU offload) and follows instructions well. llama.cpp serves whatever GGUF you
  loaded and ignores the `model` field on requests, so `GM_MODEL` only feeds the `/health` check,
  which substring-matches it against `GET /v1/models`.
- **Two-model mode (opt-in):** `RULES_MODEL` / `NARRATIVE_MODEL`. llama.cpp serves one model per
  server, so a real split needs a second `llama-server` — not reachable through a single base URL.
- **Inference cost:** zero — everything runs on your machine.

## Structure

```
packages/
├── shared/   # shared TS types (Character, GameState, Combat, CheckResult...)
├── brain/    # protagonist memory graph: markdown nodes + wikilinks, write-pass gates, graph view
├── server/   # Node/Express: REST API + GM agent (llama.cpp) + combat engine + PF2e rules data
│   └── scripts/feat-audit/   # GM regression suite: 7039 feats classified + 75-scenario battery
└── web/      # React/Vite: import, sheet, narrative scene + combat HUD (streaming via SSE)
```

## Requirements

- Node.js 20+
- An OpenAI-compatible local LLM server, started **with tool calling enabled**
  ([llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server --jinja`, or LM Studio/Ollama)
- NVIDIA GPU: a model that fully fits in ~12 GB runs smoothly; the default Gemma 4 12B (Q4) fits
  entirely on 12 GB alongside a 64k KV cache quantized to `q8_0`.

## Setup

```bash
# 1. Serve the model. llama.cpp, Gemma 4 12B (Q4) on a 12 GB card:
llama-server -m gemma-4-12b-it-UD-Q4_K_XL.gguf \
  -ngl 99 -fa on -c 65536 \
  --cache-type-k q8_0 --cache-type-v q8_0 \
  --jinja --reasoning off \
  --host 127.0.0.1 --port 1234
#    --jinja is REQUIRED: without it there is no tool calling, and the rules stage is tool calling.
#    Optional: --model-draft <MTP draft gguf> --spec-type draft-mtp  (speculative decoding, ~3x faster)

# 2. Project dependencies
npm install
cp .env.example .env   # adjust LLM_BASE_URL / GM_MODEL

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
Pathbuilder 2e export, and start playing. (The LLM server must already be up with the model loaded —
`llama-server` has no load-on-demand.) If you already have a campaign going, the import screen shows a
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

## Companions

NPCs can join you on the road (up to a party of four). When the story has someone genuinely
signing on, the GM calls a tool and the **engine** takes over: stats are resolved once from the
official bestiary statblock (or an honest level benchmark) and frozen, the companion joins combat
automatically, and **their combat turns run in code** — Strikes, multiple attack penalty, real
attack data — exactly like enemy turns. Enemies spread their retaliation across whoever is still
standing. Wounds persist between fights and across sessions; only *your* character has the
dying/recovery subsystem, so a downed companion is simply out of the fight.

Their voices go through a **gate**: at most one companion speaks per turn, chosen deterministically
(something mechanical happened to them > you addressed them by name > periodic banter > silence),
and only that one's persona reaches the narrator. A benchmark with 1–4 personas found no
degradation up to four — and, tellingly, that dumping every persona into the prompt at once doesn't
blur them, it makes them *vanish* into generic prose. The gate is what keeps them alive.

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
npm test         # 393 unit tests: combat engine, dice/degrees, dying/recovery, encounter budget, use_item, spells, rest, companions + ally turns + voice gate, brain graph + gates, save-game/recap, parser
npm run build
```

### GM regression battery (feat audit)

A reusable audit suite exercises the GM (model + engine) against real PF2e feats, grouped by
mechanical archetype, with hard assertions (action economy vs dataset cost, DC validity,
state-vs-narrative consistency). Uses the GPU/LLM server while running:

```bash
cd packages/server
npx tsx scripts/feat-audit/classify-feats.ts   # classify all 7039 feats (combat × non-combat)
npx tsx scripts/feat-audit/run-feat-tests.ts   # run the 75-scenario battery (resumable)
#   filters: --side=combat|noncombat --archetype=<name> --feat="Name" --fresh
```

## License

MIT
