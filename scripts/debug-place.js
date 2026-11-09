// debug-place.js — connect as the existing 'bot' player (keeps its server
// inventory, which already holds a crafting table) and try placing it,
// printing the exact error at each step.
const mineflayer = require('mineflayer')
const Vec3 = require('vec3')

const bot = mineflayer.createBot({
  host: '127.0.0.1',
  port: 61417,
  username: 'bot',
  version: '1.18',
})
bot.on('error', (err) => { console.error('bot error:', err.message); process.exit(1) })
bot.once('spawn', async () => {
  await bot.waitForTicks(40)
  console.log('inventory:', bot.inventory.items().map((i) => `${i.name}x${i.count}`).join(', '))
  const table = bot.inventory.items().find((i) => i.name === 'crafting_table')
  if (!table) { console.log('NO TABLE IN INVENTORY'); process.exit(0) }
  try {
    await bot.equip(table, 'hand')
    console.log('equipped table, hand:', bot.heldItem ? bot.heldItem.name : 'empty')
  } catch (err) {
    console.log('EQUIP FAILED:', err.message)
    process.exit(0)
  }
  const feet = bot.entity.position
  console.log('feet:', feet)
  for (const side of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, -1, 0)]) {
    const ref = bot.blockAt(feet.offset(side.x, side.y, side.z))
    console.log(`side ${side}: ref=${ref ? ref.name : 'null'} at ${ref ? ref.position : '?'}`)
    if (!ref || ref.name === 'air') continue
    // try placing on top of this ref block
    const target = bot.blockAt(ref.position.offset(0, 1, 0))
    console.log(`  target cell above ref: ${target ? target.name : 'null'}`)
    try {
      await bot.placeBlock(ref, new Vec3(0, 1, 0))
      console.log('  PLACE SUCCEEDED')
      const placed = bot.blockAt(ref.position.offset(0, 1, 0))
      console.log('  now there:', placed ? placed.name : 'null')
      process.exit(0)
    } catch (err) {
      console.log('  PLACE FAILED:', err.message)
    }
  }
  console.log('all sides failed')
  process.exit(0)
})
setTimeout(() => { console.error('timed out'); process.exit(1) }, 60000)
