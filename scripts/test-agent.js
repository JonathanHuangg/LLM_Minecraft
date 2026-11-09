// test-agent.js — tests for the agent loop (LLM client, planner, actor,
// and the full perceive-plan-act loop against a simulated world).
//
// No Minecraft server and no network required. The LLM client is tested
// with a mocked fetch; a live LLM call is NOT verified here (no key is
// available in this environment). The real end-to-end run against a local
// 1.18 server is scripts/e2e-server.sh.
// Usage: npm run test:agent   (or: node scripts/test-agent.js)

const assert = require('node:assert')
const path = require('path')

const { detectLLMConfig, createLLM } = require('../LLM_Minecraft/llm')
const { loadGraph, planGoal, nextAction } = require('../LLM_Minecraft/planner')
const { runAgent } = require('../LLM_Minecraft/agent')
const actor = require('../LLM_Minecraft/actor')

const GRAPH_PATH = path.join(__dirname, '..', 'assets', 'gamegraph', 'graph_1.18_craft', 'full_graph.jsonl')

let passed = 0
function ok(cond, msg) {
  assert(cond, msg)
  passed++
  console.log(`ok - ${msg}`)
}

// ---------------------------------------------------------------- LLM client
async function testLLM() {
  // config detection
  ok(detectLLMConfig({}) === null, 'no keys -> null config (demo mode)')
  ok(detectLLMConfig({ GEMINI_API_KEY: 'g-key' }).provider === 'gemini', 'GEMINI_API_KEY -> gemini')
  ok(detectLLMConfig({ OPENAI_API_KEY: 'o-key' }).provider === 'openai', 'OPENAI_API_KEY -> openai')
  ok(
    detectLLMConfig({ GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o', LLM_PROVIDER: 'openai' }).provider === 'openai',
    'LLM_PROVIDER=openai wins over auto preference',
  )
  ok(detectLLMConfig({ LLM_PROVIDER: 'gemini' }) === null, 'LLM_PROVIDER=gemini without a key -> null')

  // Gemini request shape (mocked fetch)
  let seen = null
  const mockFetch = async (url, init) => {
    seen = { url, init }
    return {
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ text: '{"action": 0, "reasoning": "chop"}' }] } }] }),
    }
  }
  const gemini = createLLM({ provider: 'gemini', apiKey: 'g-key', model: 'gemini-2.0-flash' }, mockFetch)
  const text = await gemini.complete({ system: 'sys', user: 'usr' })
  ok(text.includes('"action": 0'), 'Gemini: response text parsed')
  ok(seen.url.includes('gemini-2.0-flash:generateContent'), 'Gemini: correct endpoint + model')
  ok(seen.init.headers['x-goog-api-key'] === 'g-key', 'Gemini: key sent as header, not in URL')
  ok(!seen.url.includes('g-key'), 'Gemini: key not leaked into URL')
  const geminiBody = JSON.parse(seen.init.body)
  ok(geminiBody.contents[0].parts[0].text === 'usr', 'Gemini: user text in body')

  // OpenAI request shape (mocked fetch)
  seen = null
  const mockFetchAI = async (url, init) => {
    seen = { url, init }
    return { ok: true, json: async () => ({ choices: [{ message: { content: 'hello' } }] }) }
  }
  const openai = createLLM({ provider: 'openai', apiKey: 'o-key', model: 'gpt-4o-mini' }, mockFetchAI)
  ok((await openai.complete({ system: 'sys', user: 'usr' })) === 'hello', 'OpenAI: response text parsed')
  ok(seen.url === 'https://api.openai.com/v1/chat/completions', 'OpenAI: correct endpoint')
  ok(seen.init.headers.Authorization === 'Bearer o-key', 'OpenAI: bearer auth')
  const aiBody = JSON.parse(seen.init.body)
  ok(aiBody.messages[0].role === 'system' && aiBody.messages[1].role === 'user', 'OpenAI: system+user messages')

  // failures surface as errors, never as silent empty strings
  const failingFetch = async () => ({ ok: false, status: 401, text: async () => 'bad key' })
  const bad = createLLM({ provider: 'gemini', apiKey: 'nope', model: 'm' }, failingFetch)
  await assert.rejects(() => bad.complete({ system: 's', user: 'u' }), /HTTP 401/, 'Gemini: non-200 throws')
}

// ------------------------------------------------------------------- planner
function testPlanner() {
  const graph = loadGraph(GRAPH_PATH)
  ok(graph.opsById.size === 2283, `graph loads (${graph.opsById.size} ops)`)

  // wooden pickaxe from nothing: mine logs, craft planks, table, sticks, pickaxe
  const plan = planGoal('wooden_pickaxe', 1, {}, graph)
  ok(plan.ok, 'plan wooden_pickaxe from empty inventory')
  const kinds = plan.steps.map((s) => `${s.type}:${s.block || s.item}`)
  console.log('  plan:', kinds.join(' -> '))
  const minedLogs = plan.steps
    .filter((s) => s.type === 'mine' && s.block === 'oak_log')
    .reduce((sum, s) => sum + s.count, 0)
  ok(minedLogs === 3, `plan mines 3 oak logs total (9 planks: 4 table + 2 sticks + 3 pickaxe), got ${minedLogs}`)
  ok(plan.steps.some((s) => s.type === 'craft' && s.item === 'oak_planks'), 'plan crafts planks')
  ok(plan.steps.some((s) => s.type === 'craft' && s.item === 'crafting_table'), 'plan crafts a table')
  ok(plan.steps.some((s) => s.type === 'craft' && s.item === 'stick'), 'plan crafts sticks')
  ok(plan.steps.some((s) => s.type === 'craft' && s.item === 'wooden_pickaxe'), 'plan crafts the pickaxe')
  // dependency order: every mine before its planks, planks before table/sticks/pickaxe
  const idx = (pred) => plan.steps.findIndex(pred)
  ok(idx((s) => s.type === 'mine') < idx((s) => s.item === 'oak_planks'), 'mine steps come before planks')
  ok(idx((s) => s.item === 'oak_planks') < idx((s) => s.item === 'wooden_pickaxe'), 'planks come before pickaxe')
  ok(idx((s) => s.item === 'crafting_table') < idx((s) => s.item === 'wooden_pickaxe'), 'table comes before pickaxe')

  // a placed table is not re-crafted
  const withTable = planGoal('wooden_pickaxe', 1, {}, graph, { stations: { crafting_table: true } })
  ok(withTable.ok && !withTable.steps.some((s) => s.item === 'crafting_table'), 'placed table: no second table crafted')

  // stone pickaxe needs a wooden pickaxe first, then cobblestone
  const stone = planGoal('stone_pickaxe', 1, {}, graph)
  ok(stone.ok, 'plan stone_pickaxe from empty inventory')
  ok(stone.steps.some((s) => s.type === 'craft' && s.item === 'wooden_pickaxe'), 'stone plan crafts a wooden pickaxe first')
  const mineStone = stone.steps.find((s) => s.type === 'mine' && (s.block === 'stone' || s.block === 'cobblestone'))
  ok(mineStone && mineStone.count === 3, 'stone plan mines 3 stone/cobblestone')

  // inventory short-circuits the plan
  const haveIt = planGoal('wooden_pickaxe', 1, { wooden_pickaxe: 1 }, graph)
  ok(haveIt.ok && haveIt.done && haveIt.steps.length === 0, 'goal already in inventory -> done, no steps')
  const haveLogs = planGoal('wooden_pickaxe', 1, { oak_log: 3 }, graph)
  ok(haveLogs.ok && !haveLogs.steps.some((s) => s.type === 'mine'), '3 logs in inventory -> no mining needed')

  // cobblestone is mined from stone, not from a literal cobblestone block
  const cobble = planGoal('cobblestone', 3, { wooden_pickaxe: 1 }, graph)
  ok(cobble.ok, 'plan cobblestone with a wooden pickaxe')
  const cobbleMine = cobble.steps.find((s) => s.type === 'mine')
  ok(cobbleMine && cobbleMine.block === 'stone', `cobblestone plan mines stone first (got ${cobbleMine && cobbleMine.block})`)

  // excluding a wood family falls back to the next wood type
  const noOak = planGoal('wooden_pickaxe', 1, {}, graph, { excludeFamilies: new Set(['oak']) })
  ok(noOak.ok, 'plan wooden_pickaxe with oak excluded')
  const noOakLogs = noOak.steps
    .filter((s) => s.type === 'mine')
    .map((s) => s.block)
  ok(noOakLogs.length > 0 && noOakLogs.every((b) => !b.startsWith('oak')), `excluded oak: plan mines ${noOakLogs.join(', ')} instead`)

  // unplannable goals fail honestly
  const bad = planGoal('netherite_sword', 1, {}, graph)
  ok(!bad.ok && bad.reason, 'unplannable goal (needs netherite, smithing) reports stuck, not a fake plan')

  // nextAction wrapper
  const next = nextAction('wooden_pickaxe', {}, graph)
  ok(next.type === 'mine' && next.block === 'oak_log', 'nextAction returns the first step (mine oak_log)')
  ok(nextAction('wooden_pickaxe', { wooden_pickaxe: 1 }, graph).type === 'done', 'nextAction done when goal held')
}

// --------------------------------------------------------------------- actor
async function testActor() {
  // Fake bot: enough of the mineflayer surface for mineBlock/craftItem.
  const dug = []
  const fakeBot = {
    version: '1.18',
    registry: require('minecraft-data')('1.18'),
    _inv: [],
    inventory: { items: () => fakeBot._inv },
    findBlock: () => ({ name: 'oak_log', position: { x: 1, y: 64, z: 1 } }),
    canDigBlock: () => true,
    pathfinder: { goto: async () => {}, setMovements: () => {} },
    dig: async (block) => { dug.push(block.name); fakeBot._inv.push({ name: 'oak_log', count: 1, slot: 0 }) },
    waitForTicks: async () => {},
    equip: async () => {},
    recipesFor: () => [{ id: 1 }],
    craft: async () => { fakeBot._inv.push({ name: 'crafting_table', count: 1, slot: 1 }) },
    blockAt: () => ({ name: 'grass_block' }),
    placeBlock: async () => {},
  }
  const mined = await actor.mineBlock(fakeBot, 'oak_log', { count: 2 })
  ok(mined.ok && mined.mined === 2 && dug.length === 2, 'actor mines 2 oak logs via fake bot')
  const crafted = await actor.craftItem(fakeBot, 'crafting_table', { state: {} })
  ok(crafted.ok, 'actor crafts a crafting table via fake bot')
  const missing = await actor.mineBlock({ ...fakeBot, findBlock: () => null }, 'oak_log')
  ok(!missing.ok && /no oak_log/.test(missing.reason), 'actor reports honestly when no block is nearby')

  // ensureTable: a distant remembered table is NOT reused (the server will
  // not open a crafting window for a block out of reach); a close one is.
  const Vec3 = require('vec3')
  const tableBot = {
    version: '1.18',
    registry: require('minecraft-data')('1.18'),
    entity: { position: new Vec3(0, 64, 0) },
    blockAt: (pos) => ({ name: 'crafting_table', position: pos }),
    findBlock: () => null,
    inventory: { items: () => [] },
    recipesFor: () => [],
    craft: async () => {},
    equip: async () => {},
    placeBlock: async () => {},
  }
  const farState = { tablePosition: new Vec3(100, 64, 100) }
  const far = await actor.ensureTable(tableBot, farState)
  ok(far === null && farState.tablePosition === null, 'distant remembered table is discarded, not reused')
  const nearState = { tablePosition: new Vec3(2, 64, 0) }
  const near = await actor.ensureTable(tableBot, nearState)
  ok(near && near.name === 'crafting_table', 'close remembered table is reused')
}

// ------------------------------------------------------- simulated agent loop
async function testAgentLoop() {
  const graph = loadGraph(GRAPH_PATH)
  // Simulated world: an infinite oak forest at the bot's feet, a real
  // inventory, and execute() applying the graph's own req/prod rules.
  const sim = { inv: {}, visible: [{ name: 'oak_log' }, { name: 'oak_log' }, { name: 'grass_block' }] }
  const invItems = () => Object.entries(sim.inv)
    .filter(([, n]) => n > 0)
    .map(([name, count], i) => ({ name, count, slot: i, type: 0, metadata: 0 }))
  const fakeBot = { version: '1.18', inventory: { items: invItems } }
  const perceiveFn = () => ({
    visible: sim.visible.map((b) => ({ ...b, position: { x: 0, y: 64, z: 0 } })),
    inventory: invItems(),
    vitals: { health: 20, maxHealth: 20, food: 20, saturation: 5 },
    world: { dimension: 'minecraft:overworld', timeOfDay: 6000, day: 0, position: { x: 0, y: 64, z: 0 }, isNight: false },
  })
  const executeFn = async (_bot, step) => {
    if (step.type === 'mine') {
      // Mining yields the op's prod (stone drops cobblestone), not the
      // block name. Look it up in the graph like the craft branch does.
      const op = graph.opsById.get(step.opId)
      if (!op) return { ok: false, reason: `unknown op ${step.opId}` }
      for (const prod of op.prod || []) {
        const name = prod.objId.replace(/^item:/, '')
        sim.inv[name] = (sim.inv[name] || 0) + (prod.count || 1) * (step.count || 1)
      }
      return { ok: true, mined: step.count || 1 }
    }
    if (step.type === 'craft') {
      const op = graph.opsById.get(step.opId)
      if (!op) return { ok: false, reason: `unknown op ${step.opId}` }
      for (const req of op.req || []) {
        if (req.role !== 'consumed') continue
        const name = req.objId.replace(/^item:/, '')
        sim.inv[name] = (sim.inv[name] || 0) - (req.count || 1) * (step.count || 1)
        if (sim.inv[name] < 0) return { ok: false, reason: `sim went negative on ${name}` }
      }
      for (const prod of op.prod || []) {
        const name = prod.objId.replace(/^item:/, '')
        sim.inv[name] = (sim.inv[name] || 0) + (prod.count || 1) * (step.count || 1)
      }
      return { ok: true }
    }
    return { ok: false, reason: 'unknown step' }
  }

  const ticks = []
  const result = await runAgent(fakeBot, {
    graph,
    goal: 'wooden_pickaxe',
    maxSteps: 20,
    llm: null, // demo mode: planner decides
    log: (line) => { if (line.type === 'agent-tick') ticks.push(line) },
    perceiveFn,
    executeFn,
  })
  console.log('  sim ticks:', ticks.map((t) => t.action).join(' | '))
  ok(result.ok, `simulated loop achieves wooden_pickaxe (${result.reason})`)
  ok(sim.inv.wooden_pickaxe === 1, 'sim inventory holds the wooden pickaxe')
  ok(ticks.length <= 10, `loop finishes in a handful of ticks (${ticks.length})`)
  ok(ticks.every((t) => t.via === 'demo'), 'demo mode: every decision via the planner')

  // stone pickaxe: same sim, longer chain (needs the wooden pickaxe first)
  const sim2 = { inv: {}, visible: [{ name: 'oak_log' }, { name: 'stone' }] }
  const invItems2 = () => Object.entries(sim2.inv)
    .filter(([, n]) => n > 0)
    .map(([name, count], i) => ({ name, count, slot: i, type: 0, metadata: 0 }))
  const fakeBot2 = { version: '1.18', inventory: { items: invItems2 } }
  const perceiveFn2 = () => ({
    visible: sim2.visible.map((b) => ({ ...b, position: { x: 0, y: 64, z: 0 } })),
    inventory: invItems2(),
    vitals: { health: 20, maxHealth: 20, food: 20, saturation: 5 },
    world: { dimension: 'minecraft:overworld', timeOfDay: 6000, day: 0, position: { x: 0, y: 64, z: 0 }, isNight: false },
  })
  // Same graph-rules executor as above, but against sim2's inventory.
  const executeFn2 = async (_bot, step) => {
    if (step.type === 'mine') {
      const op = graph.opsById.get(step.opId)
      if (!op) return { ok: false, reason: `unknown op ${step.opId}` }
      for (const prod of op.prod || []) {
        const name = prod.objId.replace(/^item:/, '')
        sim2.inv[name] = (sim2.inv[name] || 0) + (prod.count || 1) * (step.count || 1)
      }
      return { ok: true, mined: step.count || 1 }
    }
    if (step.type === 'craft') {
      const op = graph.opsById.get(step.opId)
      if (!op) return { ok: false, reason: `unknown op ${step.opId}` }
      for (const req of op.req || []) {
        if (req.role !== 'consumed') continue
        const name = req.objId.replace(/^item:/, '')
        sim2.inv[name] = (sim2.inv[name] || 0) - (req.count || 1) * (step.count || 1)
        if (sim2.inv[name] < 0) return { ok: false, reason: `sim went negative on ${name}` }
      }
      for (const prod of op.prod || []) {
        const name = prod.objId.replace(/^item:/, '')
        sim2.inv[name] = (sim2.inv[name] || 0) + (prod.count || 1) * (step.count || 1)
      }
      return { ok: true }
    }
    return { ok: false, reason: 'unknown step' }
  }
  const result2 = await runAgent(fakeBot2, {
    graph,
    goal: 'stone_pickaxe',
    maxSteps: 30,
    llm: null,
    log: () => {},
    perceiveFn: perceiveFn2,
    executeFn: executeFn2,
  })
  ok(result2.ok, `simulated loop achieves stone_pickaxe (${result2.reason})`)
  ok(sim2.inv.stone_pickaxe === 1, 'sim inventory holds the stone pickaxe')

  // family fallback: oak mining fails in this sim (no oak nearby), so the
  // agent must fall back to spruce instead of retrying oak forever.
  const sim3 = { inv: {}, visible: [{ name: 'spruce_log' }] }
  const invItems3 = () => Object.entries(sim3.inv)
    .filter(([, n]) => n > 0)
    .map(([name, count], i) => ({ name, count, slot: i, type: 0, metadata: 0 }))
  const fakeBot3 = { version: '1.18', inventory: { items: invItems3 } }
  const perceiveFn3 = () => ({
    visible: sim3.visible.map((b) => ({ ...b, position: { x: 0, y: 64, z: 0 } })),
    inventory: invItems3(),
    vitals: { health: 20, maxHealth: 20, food: 20, saturation: 5 },
    world: { dimension: 'minecraft:overworld', timeOfDay: 6000, day: 0, position: { x: 0, y: 64, z: 0 }, isNight: false },
  })
  const executeFn3 = async (_bot, step) => {
    if (step.type === 'mine') {
      if (step.block === 'oak_log') return { ok: false, reason: 'no oak_log within 96 blocks' }
      const op = graph.opsById.get(step.opId)
      if (!op) return { ok: false, reason: `unknown op ${step.opId}` }
      for (const prod of op.prod || []) {
        const name = prod.objId.replace(/^item:/, '')
        sim3.inv[name] = (sim3.inv[name] || 0) + (prod.count || 1) * (step.count || 1)
      }
      return { ok: true, mined: step.count || 1 }
    }
    if (step.type === 'craft') {
      const op = graph.opsById.get(step.opId)
      if (!op) return { ok: false, reason: `unknown op ${step.opId}` }
      for (const req of op.req || []) {
        if (req.role !== 'consumed') continue
        const name = req.objId.replace(/^item:/, '')
        sim3.inv[name] = (sim3.inv[name] || 0) - (req.count || 1) * (step.count || 1)
        if (sim3.inv[name] < 0) return { ok: false, reason: `sim went negative on ${name}` }
      }
      for (const prod of op.prod || []) {
        const name = prod.objId.replace(/^item:/, '')
        sim3.inv[name] = (sim3.inv[name] || 0) + (prod.count || 1) * (step.count || 1)
      }
      return { ok: true }
    }
    return { ok: false, reason: 'unknown step' }
  }
  const ticks3 = []
  const result3 = await runAgent(fakeBot3, {
    graph,
    goal: 'wooden_pickaxe',
    maxSteps: 20,
    llm: null,
    log: (line) => { if (line.type === 'agent-tick') ticks3.push(line) },
    perceiveFn: perceiveFn3,
    executeFn: executeFn3,
  })
  console.log('  fallback ticks:', ticks3.map((t) => t.action).join(' | '))
  ok(result3.ok, `simulated loop falls back to spruce when oak is unreachable (${result3.reason})`)
  const spruceMines = ticks3.filter((t) => t.action === 'mine 1x spruce_log').length
  ok(spruceMines === 3, `fallback sim mined spruce 3 times (got ${spruceMines}), oak only failed once`)
  ok(sim3.inv.wooden_pickaxe === 1, 'fallback sim holds the wooden pickaxe')
}

async function main() {
  await testLLM()
  testPlanner()
  await testActor()
  await testAgentLoop()
  console.log(`\nagent tests passed (${passed} checks)`)
}

main().catch((err) => { console.error(err && err.stack ? err.stack : err); process.exit(1) })
