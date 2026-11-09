// probe-spawn.js — connect to the local test server and report what is
// near spawn: position, biome, nearest oak_log / stone distance.
// Usage: node probe-spawn.js (server must be running on 127.0.0.1:61417)
const mineflayer = require('mineflayer')

const bot = mineflayer.createBot({
  host: '127.0.0.1',
  port: 61417,
  username: 'probe',
  version: '1.18',
})
bot.on('error', (err) => { console.error('probe error:', err.message); process.exit(1) })
bot.once('spawn', async () => {
  await bot.waitForTicks(40) // let chunks load
  const pos = bot.entity.position
  console.log(JSON.stringify({ position: { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z) } }))
  for (const name of ['oak_log', 'birch_log', 'spruce_log', 'stone', 'dirt', 'grass_block', 'water']) {
    const block = bot.findBlock({ matching: (b) => b.name === name, maxDistance: 160, count: 1 })
    if (block) {
      console.log(`${name}: ${Math.round(pos.distanceTo(block.position))} blocks away at ${block.position}`)
    } else {
      console.log(`${name}: none within 160 blocks`)
    }
  }
  // count trees in loaded chunks (sample: any log within 160)
  const logs = bot.findBlocks({ matching: (b) => /_log$/.test(b.name), maxDistance: 160, count: 20 })
  console.log(`logs within 160 blocks: ${logs.length}`)
  process.exit(0)
})
setTimeout(() => { console.error('probe timed out'); process.exit(1) }, 60000)
