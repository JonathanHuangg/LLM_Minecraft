// planner.js — deterministic planner over the game graph.
//
// The game graph (assets/gamegraph/graph_<version>_craft/full_graph.jsonl)
// is a bipartite object <-> operation graph: every op lists what it consumes
// (req) and what it produces (prod). Given a goal item and the bot's current
// inventory, planGoal() backward-chains through the graph and returns an
// ordered list of executable steps: mine blocks, then craft items in
// dependency order.
//
// This planner is deterministic and LLM-free by design: the LLM (see llm.js
// and agent.js) chooses between grounded candidate actions and explains why,
// but it never has to invent a plan from scratch. In demo mode (no LLM key)
// the agent just executes the planner's next step.
//
// Tool gating: the graph's mine ops do not record which tool a block needs,
// so BLOCK_TOOL records the minimum pickaxe tier per block for the blocks
// this agent knows how to mine. A mine step for a gated block first resolves
// the required pickaxe as a (non-consumed) tool requirement.

const fs = require('fs')

// Minimum tool tier to mine a block. Only blocks listed here are mineable
// by this agent; anything else makes the planner report the goal stuck.
const TOOL_TIER = { hand: 0, wooden: 1, stone: 2, iron: 3 }
const BLOCK_TOOL = {
  // hand-mineable
  oak_log: 'hand',
  birch_log: 'hand',
  spruce_log: 'hand',
  jungle_log: 'hand',
  acacia_log: 'hand',
  dark_oak_log: 'hand',
  dirt: 'hand',
  grass_block: 'hand',
  sand: 'hand',
  gravel: 'hand',
  // pickaxe-gated
  stone: 'wooden',
  cobblestone: 'wooden',
  coal_ore: 'wooden',
  iron_ore: 'stone',
  gold_ore: 'iron',
  diamond_ore: 'iron',
}
const PICKAXE_FOR_TIER = {
  wooden: 'wooden_pickaxe',
  stone: 'stone_pickaxe',
  iron: 'iron_pickaxe',
}

// Blocks that occur naturally in the world. When several mine ops produce
// the same item, prefer these: a literal cobblestone block almost never
// occurs naturally, but stone (whose loot table drops cobblestone) is
// everywhere. Without this, the planner wastes a tick mining cobblestone.
const NATURAL_BLOCKS = new Set([
  'stone', 'dirt', 'grass_block', 'sand', 'gravel', 'andesite', 'diorite', 'granite',
  'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'emerald_ore', 'lapis_ore', 'redstone_ore', 'copper_ore',
  'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log',
  'oak_wood', 'birch_wood', 'spruce_wood', 'jungle_wood', 'acacia_wood', 'dark_oak_wood',
])
function mineRank(block) {
  return NATURAL_BLOCKS.has(block) ? 0 : 1
}

const STATION_TABLE = 'state:station:crafting_table'

/**
 * The "family" of a block, for exclusion after a failed mine: when oak_log
 * cannot be found nearby, every oak variant (oak_wood, stripped_oak_log,
 * ...) is equally unavailable, so the planner should fall back to the next
 * wood type instead of trying each oak variant in turn.
 */
function familyOf(block) {
  const name = String(block)
  if (/_log$/.test(name) || /_wood$/.test(name) || /_leaves$/.test(name) || /_planks$/.test(name)) {
    return name.split('_')[0]
  }
  return name
}

/**
 * Load a full_graph.jsonl file into an in-memory index.
 * @returns {{ opsByProduct: Map<string, object[]>, opsById: Map<string, object> }}
 */
function loadGraph(graphPath) {
  const opsByProduct = new Map()
  const opsById = new Map()
  const text = fs.readFileSync(graphPath, 'utf8')
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const op = JSON.parse(trimmed)
    opsById.set(op.id, op)
    for (const p of op.prod || []) {
      const name = String(p.objId).replace(/^item:/, '')
      if (!opsByProduct.has(name)) opsByProduct.set(name, [])
      opsByProduct.get(name).push(op)
    }
  }
  return { opsByProduct, opsById }
}

function itemName(objId) {
  return String(objId).replace(/^item:/, '')
}

/**
 * Plan how to obtain `goal` starting from `inventory`.
 *
 * @param {string} goal - item name, e.g. 'wooden_pickaxe'
 * @param {number} count - how many (default 1)
 * @param {object} inventory - plain object name -> count (not mutated)
 * @param {{ opsByProduct: Map }} graph - from loadGraph()
 * @param {object} [opts] - { stations: { crafting_table: boolean },
 *   excludeFamilies: Set<string> } for block families to skip (see familyOf:
 *   set after a mine step failed because the block was not nearby).
 * @returns {{ ok: true, done: boolean, steps: object[] } |
 *           { ok: false, reason: string, missing: string }}
 *   steps are ordered dependency-first and each is one of:
 *   { type: 'mine', block, count, opId }
 *   { type: 'craft', item, count, opId, requiresTable: boolean }
 */
function planGoal(goal, count = 1, inventory = {}, graph, opts = {}) {
  const inv = { ...inventory }
  const stations = opts.stations || {}
  const excludeFamilies = opts.excludeFamilies || new Set()
  const steps = []
  const resolving = new Set()

  function have(item) {
    return inv[item] || 0
  }

  // Resolve `need` units of `item`, appending steps. Returns true on success.
  // `consume: false` means "ensure it exists, don't use it up" — for tools
  // and stations, which persist after use.
  function resolve(item, need, opts = {}) {
    const consume = opts.consume !== false
    if (have(item) >= need) {
      if (consume) inv[item] -= need
      return true
    }
    need -= have(item)
    if (consume) inv[item] = 0

    if (resolving.has(item)) return false // cycle guard
    resolving.add(item)
    try {
      const producers = graph.opsByProduct.get(item) || []
      // Prefer craft ops first (they use what we can already gather), then
      // mine ops. Within one kind, prefer the variant whose inputs resolve.
      // Among mine ops, prefer naturally occurring blocks (stone over a
      // literal cobblestone block, which almost never occurs in the wild).
      const ordered = [...producers].sort((a, b) => {
        if (a.kind === 'craft' && b.kind !== 'craft') return -1
        if (a.kind !== 'craft' && b.kind === 'craft') return 1
        if (a.kind === 'mine' && b.kind === 'mine') {
          const blockA = String(a.name).replace(/^minecraft:/, '')
          const blockB = String(b.name).replace(/^minecraft:/, '')
          return mineRank(blockA) - mineRank(blockB)
        }
        return 0
      })
      for (const op of ordered) {
        if (tryOp(op, item, need)) {
          // tryOp produced `need` more than was on hand (plus surplus);
          // account for the units this resolve actually uses up.
          if (consume) inv[item] -= need
          return true
        }
      }
      return false
    } finally {
      resolving.delete(item)
    }
  }

  // Try to satisfy `need` units of `item` via one op. On success appends
  // steps and returns true; on failure leaves `steps`/`inv` untouched by
  // rolling back to a snapshot.
  function tryOp(op, item, need) {
    const prodEntry = (op.prod || []).find((p) => itemName(p.objId) === item)
    const perOp = prodEntry ? prodEntry.count || 1 : 1
    const batches = Math.ceil(need / perOp)
    const invSnapshot = { ...inv }
    const stepsSnapshot = steps.length
    const rollback = () => {
      for (const k of Object.keys(inv)) delete inv[k]
      Object.assign(inv, invSnapshot)
      steps.length = stepsSnapshot
    }

    if (op.kind === 'mine') {
      const block = String(op.name).replace(/^minecraft:/, '')
      const tier = BLOCK_TOOL[block]
      if (tier === undefined) {
        return false // block the agent does not know how to mine
      }
      if (excludeFamilies.has(familyOf(block))) {
        return false // tried and not nearby; fall back to another variant
      }
      if (tier !== 'hand') {
        // tool requirement: the pickaxe must exist (or be craftable) first;
        // it is not consumed.
        const pickaxe = PICKAXE_FOR_TIER[tier]
        if (have(pickaxe) < 1 && !resolve(pickaxe, 1, { consume: false })) {
          rollback()
          return false
        }
      }
      steps.push({ type: 'mine', block, count: need, opId: op.id })
      // mined items land in the simulated inventory
      inv[item] = (inv[item] || 0) + need
      return true
    }

    if (op.kind === 'craft') {
      // Station precondition (crafting table): resolve the table item first,
      // unless one is already placed in the world (persistent station).
      // A crafted table persists as a station, so it is never consumed.
      const preconds = (op.req || []).filter((r) => r.role === 'precond')
      for (const pre of preconds) {
        if (pre.objId === STATION_TABLE && !stations.crafting_table) {
          if (!resolve('crafting_table', 1, { consume: false })) {
            rollback()
            return false
          }
        }
      }
      // Consumed inputs.
      for (const req of op.req || []) {
        if (req.role !== 'consumed') continue
        const reqItem = itemName(req.objId)
        if (!resolve(reqItem, (req.count || 1) * batches)) {
          // roll back this op attempt entirely
          rollback()
          return false
        }
      }
      steps.push({
        type: 'craft',
        item,
        count: batches,
        opId: op.id,
        requiresTable: Boolean(op.meta && op.meta.requiresTable),
      })
      inv[item] = (inv[item] || 0) + perOp * batches
      return true
    }

    // kill / loot / furnace / brew / ... : not executed by this agent yet.
    return false
  }

  if (have(goal) >= count) return { ok: true, done: true, steps: [] }

  const ok = resolve(goal, count)
  if (!ok) {
    return { ok: false, reason: `no executable path to ${goal} from current inventory`, missing: goal }
  }
  // Coalesce adjacent mine steps for the same block (mining is idempotent).
  const merged = []
  for (const step of steps) {
    const last = merged[merged.length - 1]
    if (step.type === 'mine' && last && last.type === 'mine' && last.block === step.block) {
      last.count += step.count
    } else {
      merged.push({ ...step })
    }
  }
  return { ok: true, done: false, steps: merged }
}

/**
 * The single next action for the goal, from a fresh plan.
 * @param {object} [opts] - passed through to planGoal (e.g. { stations })
 * @returns {{ type: 'done' } | { type: 'stuck', reason: string } |
 *           { type: 'mine'|'craft', ...step, plan: object[] }}
 */
function nextAction(goal, inventory, graph, opts = {}) {
  const plan = planGoal(goal, 1, inventory, graph, opts)
  if (!plan.ok) return { type: 'stuck', reason: plan.reason, missing: plan.missing }
  if (plan.done || plan.steps.length === 0) return { type: 'done', plan: plan.steps }
  return { ...plan.steps[0], plan: plan.steps }
}

module.exports = { loadGraph, planGoal, nextAction, familyOf, BLOCK_TOOL, PICKAXE_FOR_TIER }
