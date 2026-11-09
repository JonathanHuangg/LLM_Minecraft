# LLM Minecraft

A Minecraft agent built on [Mineflayer](https://github.com/PrismarineJS/mineflayer):
a bot that **perceives** the world around it and **plans against a game graph**
of everything that can be crafted, mined, killed for, or looted in Minecraft.

> **Status: foundation, not a finished agent.** The perception layer and the
> game graph work (verified — see below). There is **no LLM wired up yet**:
> nothing in this repo calls a language model, and the bot currently takes no
> action after perceiving. The planning steps (persistent world model, choosing
> an option from the graph, survival/maintenance) are comment stubs in
> `LLM_Minecraft/main.js` waiting to be built. This README describes what the
> code actually does today, not the end goal.

Background design notes live in the
[project Google Doc](https://docs.google.com/document/d/1PKdUJSIH_MHH2Jtnqrk8QXMNHKLbwhBjtYqUvQuSmQs/edit?usp=sharing)
(reference only — this file is the source of truth for how to run it).

## How it fits together

```
LLM_Minecraft/main.js          the bot: connects, builds the graph, perceives
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

### 3. The bot (`LLM_Minecraft/main.js`)

On spawn the bot:

1. Loads `minecraft-data` for its version and builds the game graph
   (`fetch_game_data()` → `fetch_loot_data()` → `buildGraph()`).
2. Takes one perception snapshot: visible blocks, inventory, vitals, world
   state — then stops. The snapshot is computed into local variables and not
   yet used for anything; there is no movement, mining, crafting, or LLM call
   after this point.

Connection settings are hardcoded at the top of `main.js`: host
`127.0.0.1`, port `61417`, username `bot`, Minecraft **1.18**. The pathfinder
plugin is loaded but not used yet.

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

# 2. Start your 1.18 server on 127.0.0.1:61417, then start the bot
#    (works from any directory; it resolves paths relative to the file).
npm start
```

What you should see on spawn: `{"type":"status","msg":"spawned"}`, followed
by the `minecraft-data` summary, `Game data written to …`, `Loot data written
to …`, and `Graph validation passed successfully.`

### Without a server

If nothing is listening on `127.0.0.1:61417`, the bot fails cleanly and exits:

```
Bot connection error: connect ECONNREFUSED 127.0.0.1:61417
```

(The raw `ECONNREFUSED` stack trace is also printed by Mineflayer, and the
process currently exits with code 0 even on connection failure — that is a
known wart, not a successful run.)

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
- Full pipeline (`fetch_game_data` + `fetch_loot_data` + `buildGraph` for
  1.18) — passes: loot fetch pulls 986 tables / 919 items from the Mojang
  jar, full graph is 2,283 ops, matching the committed
  `graph_1.18_craft/full_graph.jsonl` op count.
- `node LLM_Minecraft/main.js` with no server — fails cleanly with
  `ECONNREFUSED` on `127.0.0.1:61417` and exits (see above). Not tested
  against a live server in this pass — that needs a running 1.18 server.
- No secrets in the repo: no API keys, tokens, or credentials are used or
  stored anywhere; `.gitignore` covers `.env` and `node_modules/`.

## Known limitations / next steps

- **No LLM, no actions.** The bot perceives once and stops; the planning and
  action sections of `main.js` are stubs. The next step is a loop that turns
  the perception snapshot + graph into a chosen op and executes it (the
  pathfinder plugin is already loaded for movement).
- **`OpKind` lists more op types than are emitted.** `furnace`, `smoke`,
  `brew`, `stonecut`, and `smith` are defined but `buildGraph()` only emits
  `craft`, `mine`, `kill`, and `loot` — smelting/brewing/etc. recipes are not
  in the graph yet.
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
- The bot **exits 0 on connection failure** (see above).
