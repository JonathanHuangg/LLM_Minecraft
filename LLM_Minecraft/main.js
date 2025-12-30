// node bot.js to run
const mineflayer = require('mineflayer')
const mcDataLoader = require('minecraft-data')
const pf = require('mineflayer-pathfinder')
const readline = require('readline')
const { GameGraph } = require('../step_0_game_graph/main')
const path = require('path')

const { getAllVisibleBlocks, getInventory, getVitals, getWorldState } = require('../mineflayer_apis/perception_utils')
const { pathfinder, Movements, goals } = pf

const MINECRAFT_VERSION = '1.18'

const bot = mineflayer.createBot({
  host: '127.0.0.1',
  port: 61417,
  username: 'bot',
  version: MINECRAFT_VERSION
})
bot.loadPlugin(pathfinder)

bot.on('error', (err) => {
  console.error('Bot connection error:', err.message ?? err)
})

bot.once('spawn', async () => {
  console.log(JSON.stringify({ type: 'status', msg: 'spawned' }))
  const mcVersion = bot.version ?? MINECRAFT_VERSION
  const mcData = mcDataLoader(mcVersion)

  // load data for graph
  const outDir = path.join(process.cwd(), '..', 'assets', 'gamegraph', `graph_${mcVersion}_craft`)
  const graph = new GameGraph(mcData, outDir)
  graph.fetch_game_data()
  await graph.fetch_loot_data()
  graph.buildGraph()

  // --- PERCEPTION AND STATE RECORDING 

  // get all the current state data
  const visible_blocks = getAllVisibleBlocks(bot)

  // slot, name, count, type metadata
  const inventory = getInventory(bot)

  // health, maxHealth, food, saturation
  const vitals = getVitals(bot)

  // dimension, timeOfDay, day, position (x, y, z), isNight
  const worldState = getWorldState(bot)
})



// retrieve landmarks

// load last acton result


// --- PERSISTENT WORLD MODEL UPDATE

// --- COMPUTE OPTIONS FROM DAG

// --- MAINTENANCE AND SURVIVAL
