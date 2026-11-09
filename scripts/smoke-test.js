// Smoke test: no Minecraft server, no network required.
// Loads every module, builds the 1.18 game graph from minecraft-data
// (craft ops only; loot data needs a Mojang download, so it is skipped here),
// and asserts a valid full_graph.jsonl is written to a scratch dir.
// Usage: npm test   (or: npm run smoke)
const fs = require('fs')
const path = require('path')

const { GameGraph } = require('../step_0_game_graph/main')
const perception = require('../mineflayer_apis/perception_utils')
const helper = require('../mineflayer_apis/helper_utils')
const { fetchLootIndexForVersion } = require('../step_0_game_graph/loot_fetcher')

function assert(cond, msg) {
  if (!cond) throw new Error(`smoke test failed: ${msg}`)
  console.log(`ok - ${msg}`)
}

async function main() {
  // 1. every module loads and exports what the bot uses
  assert(typeof GameGraph === 'function', 'GameGraph loads')
  for (const fn of ['getAllVisibleBlocks', 'getInventory', 'getVitals', 'getWorldState']) {
    assert(typeof perception[fn] === 'function', `perception_utils exports ${fn}`)
  }
  for (const fn of ['getEyePosition', 'wrapToPi', 'raycastBlock']) {
    assert(typeof helper[fn] === 'function', `helper_utils exports ${fn}`)
  }
  assert(typeof fetchLootIndexForVersion === 'function', 'loot_fetcher loads')

  // 2. build the craft-only graph for 1.18 into a scratch dir (no network, no loot)
  const outDir = path.join(__dirname, '..', '.smoke-out')
  fs.rmSync(outDir, { recursive: true, force: true })
  const mcData = require('minecraft-data')('1.18')
  const graph = new GameGraph(mcData, outDir)
  graph.fetch_game_data()
  assert(Object.keys(graph.items).length > 1000, `1.18 game data loaded (${Object.keys(graph.items).length} items)`)
  graph.buildGraph() // must not crash without loot data (see README: known fix)
  assert(graph.errors.length === 0, 'graph validation passed with no errors')

  const graphPath = path.join(outDir, 'full_graph.jsonl')
  // GraphDumper closes its write stream asynchronously, so wait for the
  // file to appear (and settle) before reading it.
  const deadline = Date.now() + 5000
  let size = -1
  while (Date.now() < deadline) {
    try {
      const next = fs.statSync(graphPath).size
      if (next === size && next > 0) break
      size = next
    } catch { /* not created yet */ }
    await new Promise((r) => setTimeout(r, 100))
  }
  assert(size > 0, 'full_graph.jsonl written')
  const lines = fs.readFileSync(graphPath, 'utf8').trim().split('\n')
  assert(lines.length > 1000, `full_graph.jsonl has ${lines.length} ops`)
  const first = JSON.parse(lines[0])
  assert(first.id && first.kind && Array.isArray(first.req) && Array.isArray(first.prod),
    'graph records have id/kind/req/prod shape')
  const kinds = new Set(lines.map(l => JSON.parse(l).kind))
  assert(kinds.has('craft'), 'graph contains craft ops')
  assert(!kinds.has('mine') && !kinds.has('kill'), 'craft-only graph has no mine/kill ops without loot data')

  // 3. clean up scratch output (the minecraft_1.18.json snapshot that
  // fetch_game_data() writes under assets/ is git-ignored by design)
  fs.rmSync(outDir, { recursive: true, force: true })
  console.log('smoke test passed')
}

main().catch((err) => { console.error(err.message); process.exit(1) })
