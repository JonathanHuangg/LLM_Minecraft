// main.js — entry point for the LLM Minecraft agent.
//
// The bot connects to a Minecraft: Java Edition server, builds the game
// graph, then runs the perceive -> plan -> decide -> act loop (see agent.js)
// until it achieves GOAL or runs out of steps.
//
// Config (environment variables; see .env.example):
//   MC_HOST, MC_PORT, MC_USERNAME, MINECRAFT_VERSION — server connection
//   GOAL             — item to obtain, e.g. wooden_pickaxe (default)
//   MAX_STEPS        — max agent ticks before giving up (default 60)
//   LLM_PROVIDER     — gemini | openai | auto (default auto)
//   GEMINI_API_KEY / OPENAI_API_KEY — LLM key; unset = demo mode (the
//   deterministic planner decides; the loop is still fully real)
//   LLM_MODEL        — model override
//
// Run:  npm start          (needs a 1.18 server on 127.0.0.1:61417)
//       GOAL=stone_pickaxe npm start
//
// Exit code is 0 only when the goal is achieved; anything else exits 1.

const mineflayer = require('mineflayer')
const mcDataLoader = require('minecraft-data')
const pf = require('mineflayer-pathfinder')
const path = require('path')
const fs = require('fs')

const { GameGraph } = require('../step_0_game_graph/main')
const { loadGraph } = require('./planner')
const { runAgent } = require('./agent')
const { detectLLMConfig, createLLM } = require('./llm')

const MINECRAFT_VERSION = process.env.MINECRAFT_VERSION || '1.18'
const HOST = process.env.MC_HOST || '127.0.0.1'
const PORT = Number(process.env.MC_PORT || 61417)
const USERNAME = process.env.MC_USERNAME || 'bot'
const GOAL = process.env.GOAL || 'wooden_pickaxe'
const MAX_STEPS = Number(process.env.MAX_STEPS || 60)

function logLine(obj) {
  console.log(JSON.stringify(obj))
}

const bot = mineflayer.createBot({
  host: HOST,
  port: PORT,
  username: USERNAME,
  version: MINECRAFT_VERSION,
})
bot.loadPlugin(pf.pathfinder)

bot.on('error', (err) => {
  console.error('Bot connection error:', err.message ?? err)
  process.exit(1)
})

bot.once('spawn', async () => {
  logLine({ type: 'status', msg: 'spawned', host: HOST, port: PORT, goal: GOAL })
  try {
    const mcVersion = bot.version ?? MINECRAFT_VERSION
    const mcData = mcDataLoader(mcVersion)

    // Build the game graph (validates it), then load it for planning.
    const outDir = path.join(__dirname, '..', 'assets', 'gamegraph', `graph_${mcVersion}_craft`)
    const graphFile = path.join(outDir, 'full_graph.jsonl')
    const graph = new GameGraph(mcData, outDir)
    graph.fetch_game_data()
    await graph.fetch_loot_data()
    graph.buildGraph()
    // The dumper writes through an async stream: wait for it to flush
    // before reading the file, or the planner loads a truncated graph.
    await new Promise((resolve, reject) => {
      const stream = graph.writer.fullOps
      if (stream.writableFinished) return resolve()
      const timer = setTimeout(() => reject(new Error('graph write timed out')), 30000)
      stream.once('finish', () => { clearTimeout(timer); resolve() })
      stream.once('error', (err) => { clearTimeout(timer); reject(err) })
    })
    if (!fs.existsSync(graphFile)) {
      throw new Error(`graph was not written to ${graphFile}`)
    }
    const index = loadGraph(graphFile)
    logLine({ type: 'status', msg: 'graph loaded', ops: index.opsById.size })

    // LLM (optional): a key in the environment wires the model up;
    // without one the agent runs in demo mode on the planner alone.
    const llmConfig = detectLLMConfig()
    let llm = null
    if (llmConfig) {
      llm = createLLM(llmConfig)
      logLine({ type: 'status', msg: 'llm enabled', provider: llm.provider, model: llm.model })
    } else {
      logLine({ type: 'status', msg: 'demo mode: no LLM key set, planner decides' })
    }

    const result = await runAgent(bot, {
      graph: index,
      goal: GOAL,
      maxSteps: MAX_STEPS,
      llm,
      log: logLine,
    })
    console.log(result.ok ? `GOAL ACHIEVED: ${result.reason}` : `AGENT STOPPED: ${result.reason}`)
    process.exit(result.ok ? 0 : 1)
  } catch (err) {
    console.error('Agent failed:', err && err.stack ? err.stack : err)
    process.exit(1)
  }
})
