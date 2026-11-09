// actor.js — executes planner steps against a real Mineflayer bot.
//
// One function per step type from planner.js. Every function returns
// { ok: boolean, ...detail } and never throws for an expected in-world
// failure (no block nearby, dig interrupted, ...); unexpected programmer
// errors still throw so tests surface them.
//
// The actor keeps world state the planner needs: a placed crafting table
// (position remembered so later table recipes reuse it instead of crafting
// a second table).

const Vec3 = require('vec3')
const pf = require('mineflayer-pathfinder')

function ensureMovements(bot) {
  if (bot._llmMovementsSet) return
  const { Movements } = pf
  bot.pathfinder.setMovements(new Movements(bot))
  bot._llmMovementsSet = true
}

function mcDataFor(bot) {
  return require('minecraft-data')(bot.version)
}

/** Count an item in the bot's inventory. */
function countItem(bot, name) {
  return bot.inventory.items()
    .filter((i) => i.name === name)
    .reduce((sum, i) => sum + i.count, 0)
}

/**
 * Mine `count` blocks of `blockName` near the bot.
 * @returns {Promise<{ok: boolean, mined?: number, reason?: string}>}
 */
async function mineBlock(bot, blockName, { count = 1, maxDistance = 96 } = {}) {
  ensureMovements(bot)
  const mcData = mcDataFor(bot)
  const blockType = mcData.blocksByName[blockName]
  if (!blockType) return { ok: false, reason: `unknown block: ${blockName}` }

  let mined = 0
  let lastReason = ''
  for (let i = 0; i < count; i++) {
    const before = countItem(bot, blockName)
    // Try the nearest few blocks of this type: the closest one is sometimes
    // unreachable (across a river, inside a tree), while the next one is not.
    const candidates = bot.findBlock({
      matching: (b) => b.name === blockName,
      maxDistance,
      count: 3,
    }) || []
    const list = Array.isArray(candidates) ? candidates : [candidates]
    let dugThisRound = false
    for (const block of list) {
      if (!block) continue
      try {
        const { goals } = pf
        // Bound each path attempt: the pathfinder can spend a minute on an
        // unreachable block, and this loop tries up to 3 candidates.
        const goal = new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2)
        await Promise.race([
          bot.pathfinder.goto(goal),
          new Promise((_, reject) => setTimeout(() => reject(new Error('pathfinder timeout after 15s')), 15000)),
        ])
        // canDigBlock is distance-sensitive, so it is only meaningful once
        // the bot has walked up to the block.
        if (!bot.canDigBlock(block)) {
          lastReason = `cannot dig ${blockName} here (no tool or blocked)`
          continue
        }
        await equipBestTool(bot, block)
        await bot.dig(block)
        dugThisRound = true
        break
      } catch (err) {
        // Do NOT call bot.pathfinder.stop() here: an abandoned goto is
        // cleaned up by the next setGoal (the pathfinder's own
        // goal_updated handler). stop() emits path_stop, which rejects the
        // NEXT goto with "Path was stopped" instead.
        lastReason = `dig failed: ${err.message}`
      }
    }
    if (!dugThisRound) {
      return {
        ok: mined > 0,
        mined,
        reason: mined > 0
          ? `mined ${mined}/${count} ${blockName}, then ${lastReason || 'no reachable block'}`
          : lastReason || `no ${blockName} within ${maxDistance} blocks`,
      }
    }
    // drops pop out and are picked up on contact; give them a moment
    await bot.waitForTicks(12)
    const after = countItem(bot, blockName)
    if (after > before) mined += after - before
    else mined += 1 // dug it; the drop may already be counted under another name
  }
  return { ok: mined >= count, mined }
}

/** Equip the best tool in inventory for a block (best pickaxe, else empty hand). */
async function equipBestTool(bot, block) {
  const tools = bot.inventory.items().filter((i) => /_pickaxe$/.test(i.name) || /_axe$/.test(i.name) || /_shovel$/.test(i.name))
  if (tools.length === 0) return
  // crude tier ranking: diamond > iron > stone > wooden; pickaxe first
  const tier = { wooden: 1, stone: 2, iron: 3, golden: 2, diamond: 4, netherite: 5 }
  const score = (item) => {
    const m = item.name.match(/^(wooden|stone|iron|golden|diamond|netherite)_(pickaxe|axe|shovel)$/)
    if (!m) return 0
    return (tier[m[1]] || 0) * 10 + (m[2] === 'pickaxe' ? 3 : m[2] === 'axe' ? 2 : 1)
  }
  const best = tools.sort((a, b) => score(b) - score(a))[0]
  if (best) {
    try { await bot.equip(best, 'hand') } catch { /* keep whatever is equipped */ }
  }
}

/**
 * Craft `count` of `itemName`, placing a crafting table first when the
 * recipe needs one and none is placed yet.
 *
 * @param {object} state - agent state, mutated: { tablePosition: Vec3|null }
 * @returns {Promise<{ok: boolean, reason?: string, placedTable?: boolean}>}
 */
async function craftItem(bot, itemName, { count = 1, state = {} } = {}) {
  ensureMovements(bot)
  const mcData = mcDataFor(bot)
  const item = mcData.itemsByName[itemName]
  if (!item) return { ok: false, reason: `unknown item: ${itemName}` }

  let tableBlock = null
  // First try without a table (2x2 recipes); if that yields nothing, the
  // recipe needs a table.
  let recipes = bot.recipesFor(item.id, null, 1, null) || []
  let recipe = recipes[0]
  if (!recipe) {
    tableBlock = await ensureTable(bot, state)
    if (!tableBlock) return { ok: false, reason: `could not place a crafting table for ${itemName}` }
    recipes = bot.recipesFor(item.id, null, 1, tableBlock) || []
    recipe = recipes[0]
    if (!recipe) return { ok: false, reason: `no recipe for ${itemName} even with a crafting table` }
  }

  try {
    await bot.craft(recipe, count, tableBlock)
  } catch (err) {
    return { ok: false, reason: `craft failed: ${err.message}` }
  }
  return { ok: true }
}

/**
 * Make sure a crafting table block exists near the bot. Reuses the placed
 * table when one is recorded, else crafts one from planks and places it.
 * @returns {Promise<object|null>} the table block, or null on failure
 */
async function ensureTable(bot, state) {
  // Reuse the table we already placed — but only if the bot is still close
  // enough to use it (the server will not open a crafting window for a
  // block out of reach). A stale position from an earlier run, or from
  // before the bot walked off to mine, must not be trusted blindly.
  const REACH = 5
  if (state.tablePosition) {
    const block = bot.blockAt(state.tablePosition)
    const near = block && bot.entity.position.distanceTo(state.tablePosition) <= REACH
    if (block && block.name === 'crafting_table' && near) return block
    state.tablePosition = null // gone, or too far away; find or place a new one
  }
  // One may already be nearby (e.g. placed by a previous run). Only
  // within reach: the server will not open the window for a distant table.
  const nearby = bot.findBlock({ matching: (b) => b.name === 'crafting_table', maxDistance: 5 })
  if (nearby) {
    state.tablePosition = nearby.position.clone()
    return nearby
  }
  // Or already in the inventory (the planner's table step crafted it) —
  // place that one instead of crafting a second table.
  let tableInHand = bot.inventory.items().find((i) => i.name === 'crafting_table')
  if (!tableInHand) {
    // Craft one: 4 planks of any one wood type.
    const mcData = mcDataFor(bot)
    const tableItem = mcData.itemsByName.crafting_table
    const recipes = bot.recipesFor(tableItem.id, null, 1, null) || []
    if (recipes.length === 0) return null
    try {
      await bot.craft(recipes[0], 1, null)
    } catch {
      return null
    }
    tableInHand = bot.inventory.items().find((i) => i.name === 'crafting_table')
    if (!tableInHand) return null
  }
  // Place it on the ground NEXT to the bot, not in the cell the bot itself
  // occupies (the server refuses to place a block where a player stands).
  // Try a ring of candidate spots at two heights and out to 2 blocks, and
  // only attempt spots whose target cell is actually empty: the bot often
  // stands inside a tree canopy, where the adjacent cells are leaves.
  try {
    await bot.equip(tableInHand, 'hand')
    const feet = bot.entity.position
    const candidates = []
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
      for (const dy of [-1, 0]) {
        candidates.push(feet.offset(dx, dy, dz))
      }
    }
    for (const pos of candidates) {
      const ref = bot.blockAt(pos)
      if (!ref || ref.name === 'air') continue
      const target = bot.blockAt(ref.position.offset(0, 1, 0))
      if (!target || (target.name !== 'air' && target.name !== 'cave_air')) continue
      try {
        await bot.placeBlock(ref, new Vec3(0, 1, 0))
      } catch {
        continue
      }
      const placed = bot.blockAt(ref.position.offset(0, 1, 0))
      if (placed && placed.name === 'crafting_table') {
        state.tablePosition = placed.position.clone()
        return placed
      }
    }
  } catch {
    return null
  }
  return null
}

/**
 * Execute one planner step.
 * @param {object} step - { type: 'mine', block, count } | { type: 'craft', item, count }
 * @param {object} state - agent state (table position, ...)
 */
async function executeStep(bot, step, state = {}) {
  if (step.type === 'mine') {
    return mineBlock(bot, step.block, { count: step.count || 1 })
  }
  if (step.type === 'craft') {
    return craftItem(bot, step.item, { count: step.count || 1, state })
  }
  return { ok: false, reason: `unknown step type: ${step.type}` }
}

module.exports = { mineBlock, craftItem, ensureTable, executeStep, countItem, ensureMovements }
