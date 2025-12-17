const mineflayer = require('mineflayer')
const mcDataLoader = require('minecraft-data')
const pf = require('mineflayer-pathfinder')
const readline = require('readline')

const { getAllVisibleBlocks } = require('./perception_utils')
const { pathfinder, Movements, goals } = pf

const bot = mineflayer.createBot({
  host: '127.0.0.1',
  port: 51737,
  username: 'bot'
})

bot.loadPlugin(pathfinder)


bot.once('spawn', () => {
  console.log(JSON.stringify({ type: 'status', msg: 'spawned' }))

  const mcData = mcDataLoader(bot.version)
  const movements = new Movements(bot, mcData)
  bot.pathfinder.setMovements(movements)

  // Walk to x=0 z=0
  bot.pathfinder.setGoal(new goals.GoalXZ(0, 0))
})

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
})

rl.on('line', (line) => {
  const cmd = line.trim()

  if (cmd === 'l') {
    const blocks = getAllVisibleBlocks(bot, {
      maxDist: 64,
      hfovDeg: 90,
      vfovDeg: 60,
      yawStep: 2.0,
      pitchStep: 2.0,
      includeAir: false
    })

    const blockCounts = Object.create(null)

    // just for testing to see which blocks are seen
    for (const b of blocks) {
    const name = b.name
    blockCounts[name] = (blockCounts[name] || 0) + 1
    }

    console.log(JSON.stringify({
        type: 'visible_block_counts',
        unique: Object.keys(blockCounts).length,
        total: blocks.length,
        blocks: blockCounts
    }))
  } else if (cmd === 'stop') {
    bot.pathfinder.setGoal(null)
    console.log(JSON.stringify({ type: 'status', msg: 'stopped pathfinder' }))
  }
})
