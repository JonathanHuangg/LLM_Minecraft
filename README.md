# LLM Minecraft

A Minecraft agent built on [Mineflayer](https://github.com/PrismarineJS/mineflayer):
a bot that **perceives** the world around it, **plans against a game graph**
of everything that can be crafted, mined, killed for, or looted in Minecraft,
and **acts on that plan** — mining blocks and crafting items until it achieves
a goal, with a real LLM in the loop when one is configured.

> **Status: a working agent.** The bot runs a perceive → plan → decide → act
> loop against a live 1.18 server and has achieved `wooden_pickaxe` from an
> empty inventory end to end (verified — see below). The LLM is wired up
> (Gemini or OpenAI, key from an environment variable, never committed); with
> no key set the agent runs in **demo mode**, where the deterministic graph
> planner picks every action and the loop is otherwise identical. A live LLM
> call has not been verified in this environment (no key is available here);
> the client itself is tested with a mocked transport.

Background design notes live in the
[project Google Doc](https://docs.google.com/document/d/1PKdUJSIH_MHH2Jtnqrk8QXMNHKLbwhBjtYqUvQuSmQs/edit?usp=sharing)
(reference only — this file is the source of truth for how to run it).

## How it fits together

```
LLM_Minecraft/main.js          entry point: connects, builds the graph, runs the agent loop
  ├─ LLM_Minecraft/agent.js    the loop: perceive -> plan -> decide -> act, one JSON line per tick
  ├─ LLM_Minecraft/planner.js  deterministic planner over the game graph (backward chaining)
  ├─ LLM_Minecraft/actor.js    executes steps against the live bot (mine, craft, place table)
  ├─ LLM_Minecraft/llm.js      Gemini / OpenAI client (REST, no extra deps; env keys only)
  ├─ mineflayer_apis/          perception: what the bot can see / sense
  └─ step_0_game_graph/        step 0: the game graph the planner will use
       └─ assets/gamegraph/   generated data (snapshots + graph files)
```

### 1. The game graph (`step_0_game_graph/`)

`GameGraph` (`step_0_game_graph/main.js`) builds a bipartite
**object ↔ operation** graph from game data:

- **Objects** — every item and block, from
  [`minecraft-data`](https://github.com/PrismarineJS/minecraft-data).
- **Operations** — one record per way to obtain something, written to
  `assets/gamegraph/graph_<version>_craft/full_graph.jsonl` (one JSON object
  per line: `{ id, kind, name, meta, req, prod }`, where `req` lists consumed
  inputs / preconditions and `prod` lists what the op yields).
  - `craft` ops come from `minecraft-data` recipes (including an inferred
    `requiresTable` flag for recipes bigger than a 2×2 grid).
  - `mine` / `kill` / `loot` ops come from loot tables parsed out of the
    official server jar (see below).

For Minecraft 1.18 the generated graph has **2,283 ops**: 1,297 craft,
835 mine, 91 kill, 60 loot. `buildGraph()` validates that every edge
references a known op and object, and reports failures instead of writing a
bad graph.

`loot_fetcher.js` downloads the server jar for the requested version from
Mojang (`piston-meta.mojang.com`, ~46 MB, cached under
`assets/gamegraph/.cache/`), then parses item tags and loot tables out of it,
expanding nested tags (`#minecraft:planks`, …) and loot-table references so
each table maps to the full set of items it can drop.

`step_0_main_apis.js` (`GameGraphApi`) is a thin wrapper around `GameGraph`
whose `getFrontiers()` is still an empty stub.

### 2. Perception (`mineflayer_apis/`)

What the bot can sense, all in `perception_utils.js` (helpers in
`helper_utils.js`):

- `getAllVisibleBlocks(bot)` — a LiDAR-style raycast sweep from the bot's eye
  position: 64-block range, 90° horizontal / 60° vertical field of view, 2°
  steps by default. Returns the deduped list of blocks hit, each annotated
  with distance and face hit.
- `getInventory(bot)` — slot, name, count, type, metadata per item.
- `getVitals(bot)` — health, max health, food, saturation.
- `getWorldState(bot)` — dimension, time of day, day number, position,
  whether it is night.

### 3. The agent loop (`LLM_Minecraft/agent.js`, `planner.js`, `actor.js`, `llm.js`)

On spawn the bot:

1. Loads `minecraft-data` for its version and builds the game graph
   (`fetch_game_data()` → `fetch_loot_data()` → `buildGraph()`), then loads
   the built graph for planning.
2. Runs the loop until the goal item is in its inventory (or it gets stuck,
   or `MAX_STEPS` ticks pass). Each tick:
   - **Perceive** — visible blocks, inventory, vitals, world state.
   - **Plan** — the deterministic planner backward-chains through the graph
     from the goal to the current inventory and returns the next executable
     step (mine a block, craft an item). It accounts for tool requirements
     (stone needs a wooden pickaxe) and for the crafting table as a
     persistent station, not a consumable.
   - **Decide** — with an LLM configured, the model picks between the
     grounded candidate actions and explains why; without one (demo mode)
     the planner's next step is taken. A malformed LLM reply falls back to
     the planner's step, never to an invented action.
   - **Act** — the actor walks to the block and digs it, or crafts the item
     (placing a crafting table first when the recipe needs one). If a mine
     step fails because the block is not nearby, the whole block family is
     excluded and the next tick's plan falls back to another variant
     (oak unreachable → spruce).
3. Logs one JSON line per tick (`{"type":"agent-tick", ...}`) and a final
   `agent-result` line, so a run is auditable after the fact. Exit code is
   0 only when the goal is achieved.

Connection and agent settings come from environment variables (see
`.env.example`): `MC_HOST`, `MC_PORT`, `MC_USERNAME`,
`MINECRAFT_VERSION` (default `1.18`), `GOAL` (default `wooden_pickaxe`),
`MAX_STEPS` (default `60`), `LLM_PROVIDER` (`gemini` / `openai` / `auto`),
`GEMINI_API_KEY` / `OPENAI_API_KEY`, `LLM_MODEL`.

### 4. The LLM (`LLM_Minecraft/llm.js`)

Gemini (`gemini-2.0-flash` by default) and OpenAI (`gpt-4o-mini` by default)
over their REST APIs with Node's built-in `fetch` — no extra dependency.
Keys come from environment variables only; nothing reads a key from disk,
and keys are never logged. With no key set, `detectLLMConfig()` returns
null and the agent runs in demo mode (see above).

## Prerequisites

- **Node.js 18+** (verified on Node 24.22.1, npm 10.9.4).
- **A Minecraft: Java Edition server, version 1.18**, reachable at
  `127.0.0.1:61417` — for local testing, an offline-mode server (vanilla or
  Paper) is the easy route, since the bot connects as username `bot` with no
  password and no auth option set in code. Edit `host`, `port`, `username`,
  and `MINECRAFT_VERSION` at the top of `LLM_Minecraft/main.js` to point at
  a different server.
- **Internet access** on first run: `fetch_loot_data()` downloads the 1.18
  server jar from Mojang. (The graph build itself is offline after that.)

## Run it

```bash
git clone https://github.com/JonathanHuangg/LLM_Minecraft.git
cd LLM_Minecraft
npm install

# 1. Smoke test — no server, no network. Loads every module and rebuilds
#    the 1.18 graph (craft ops only) into a scratch dir, then cleans up.
npm test

# 2. Agent tests — planner, LLM client (mocked fetch), actor (fake bot),
#    and the full loop against a simulated world. No server, no network.
npm run test:agent

# 3. Start your 1.18 server on 127.0.0.1:61417, then start the bot
#    (works from any directory; it resolves paths relative to the file).
#    scripts/e2e-server.sh does the server setup + run for you:
#      ./scripts/e2e-server.sh wooden_pickaxe 60
npm start

# With an LLM in the loop (keys are never committed; see .env.example):
#   GEMINI_API_KEY=... npm start
#   OPENAI_API_KEY=... LLM_PROVIDER=openai npm start
#   GOAL=stone_pickaxe npm start
```

What you should see on spawn: `{"type":"status","msg":"spawned"}`, followed
by the `minecraft-data` summary, `Game data written to …`, `Loot data written
to …`, and `Graph validation passed successfully.`, then one
`{"type":"agent-tick", ...}` line per action and a final
`GOAL ACHIEVED: …` line. Without a key you will also see
`{"type":"status","msg":"demo mode: no LLM key set, planner decides"}`.

### Without a server

If nothing is listening on `127.0.0.1:61417`, the bot fails cleanly and exits
with code 1:

```
Bot connection error: connect ECONNREFUSED 127.0.0.1:61417
```

## Generated data

Running the bot writes (all git-ignored except the committed 1.18 graph):

| File | What it is |
| --- | --- |
| `assets/gamegraph/minecraft_<version>.json` | Full `minecraft-data` snapshot: items, blocks, entities, recipes + counts |
| `assets/gamegraph/minecraft_<version>_loot.json` | Loot-table index: table → items, item → sources |
| `assets/gamegraph/graph_<version>_craft/full_graph.jsonl` | The built graph, one op per line |
| `assets/gamegraph/.cache/server_<version>.jar` | Downloaded Mojang server jar (loot source) |

Committed in the repo: `assets/gamegraph/graph_1.18_craft/full_graph.jsonl`
(2,283 ops, regenerated and verified 2026-11-09) and
`assets/gamegraph/minecraft_1.21.8.json` (1,416 items, 1,105 blocks,
151 entities, 829 recipe outputs) — note the version skew: the bot targets
**1.18** while the committed snapshot is from **1.21.8**. A 1.18 snapshot is
generated on every run instead.

## Verification (2026-11-09)

- `npm install` — clean (97 packages; only deprecation warnings from
  transitive `uuid` versions).
- `npm test` — passes: all modules load, 1.18 data loads (1,100 items,
  898 blocks, 113 entities), craft-only graph builds with zero validation
  errors (1,297 ops).
- `npm run test:agent` — passes (51 checks): LLM client request/response
  shapes for Gemini and OpenAI with a mocked fetch (keys sent as headers,
  never in URLs); planner produces the correct 9-step wooden-pickaxe plan
  from an empty inventory (3 logs → planks → table → sticks → pickaxe) and
  the correct stone-pickaxe plan (wooden pickaxe first, then 3 stone, and
  cobblestone plans via mining stone, not a literal cobblestone block);
  the simulated loop achieves `wooden_pickaxe` in 9 ticks and
  `stone_pickaxe` end to end, and falls back from oak to spruce when oak
  mining fails; the actor mines/crafts against a fake bot and discards a
  remembered crafting table that is out of reach.
- Full pipeline (`fetch_game_data` + `fetch_loot_data` + `buildGraph` for
  1.18) — passes: loot fetch pulls 986 tables / 919 items from the Mojang
  jar, full graph is 2,283 ops, matching the committed
  `graph_1.18_craft/full_graph.jsonl` op count.
- **Live end-to-end (real vanilla 1.18 server, offline mode, demo mode):**
  from an empty inventory in a fresh world, the bot achieved
  `wooden_pickaxe` in 9 ticks and exited 0: mined 3 oak logs, crafted
  planks, crafted and placed a crafting table, crafted sticks, crafted the
  wooden pickaxe. On a fresh world (oak 7 blocks away, stone 4 away) it
  then achieved `stone_pickaxe` in 7 ticks and exited 0, reusing the
  wooden pickaxe from the earlier run: mined 1 oak log, crafted planks
  and a second table, mined stone 3 times, crafted the stone pickaxe.
  The run also caught and fixed three real bugs: the planner tried a
  literal cobblestone block first (now prefers naturally occurring stone),
  a path failure wrongly excluded the whole stone family (exclusion is now
  absence-only), and an abandoned goto's `stop()` call rejected the next
  goto (abandoned gotos are now left for the pathfinder's own
  `goal_updated` cleanup).
- `node LLM_Minecraft/main.js` with no server — fails cleanly with
  `ECONNREFUSED` on `127.0.0.1:61417` and exits 1 (the old exit-0 wart is
  fixed).
- No secrets in the repo: no API keys, tokens, or credentials are used or
  stored anywhere; `.gitignore` covers `.env` and `node_modules/`, and
  `.env.example` documents the variables with empty values.

## Known limitations / next steps

- **A live LLM call has not been verified.** The Gemini/OpenAI client is
  tested with a mocked fetch only; no key was available in this
  environment. Run it once with a real key and check the tick log shows
  `"via":"llm"` decisions.
- **Mine ops for player-made blocks.** Fixed during the stone-pickaxe run:
  the planner now prefers naturally occurring blocks (stone over a literal
  cobblestone block), and family exclusion only fires on absence, so one
  bad path cannot kill the only route to the goal. The graph still models
  the mine op by its block, so a goal that can only be mined from a
  player-made block (e.g. stone bricks) still reports stuck honestly.
- **No survival behavior yet.** The loop does not eat, avoid mobs, or
  handle night; the E2E server runs on peaceful difficulty for that reason.
  Health/food are perceived and shown to the LLM, but nothing acts on them.
- **`OpKind` lists more op types than are emitted.** `furnace`, `smoke`,
  `brew`, `stonecut`, and `smith` are defined but `buildGraph()` only emits
  `craft`, `mine`, `kill`, and `loot` — smelting/brewing/etc. recipes are not
  in the graph yet, so goals needing them (iron ingots, torches via coal)
  report stuck honestly.
- **Loot counts are placeholders.** Loot/mine/kill ops record `count: 1` for
  every drop (`count unknown; you can refine later` in the code) — drop
  quantities and chances are not modeled.
- **`GameGraphApi.getFrontiers()` is an empty stub**, and its constructor
  previously crashed `buildGraph()` by never fetching loot data (fixed: the
  graph now builds craft-only with a warning when loot is missing).
- **Graph output path was cwd-dependent** (`process.cwd()` + `..` broke when
  run from the repo root); fixed to resolve from `__dirname`.
- **No `package.json` existed** before this change, so none of the five
  dependencies (`mineflayer`, `minecraft-data`, `mineflayer-pathfinder`,
  `vec3`, `adm-zip`) were declared. Added with a lockfile.
