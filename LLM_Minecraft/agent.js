// agent.js — the perceive -> plan -> decide -> act loop.
//
// Each tick:
//   1. Perceive: visible blocks (LiDAR sweep), inventory, vitals, world state.
//   2. Plan: the deterministic graph planner computes the next step toward
//      the goal from the real inventory (agent.js never trusts a stale plan).
//   3. Decide: with an LLM configured, the model picks between the grounded
//      candidate actions and explains why; without one (demo mode) the
//      planner's next step is taken. A malformed LLM reply falls back to
//      the planner's step, never to an invented action.
//   4. Act: the actor executes the step against the live bot.
//   5. Log one JSON line per tick, so a run is auditable after the fact.
//
// The loop stops when the goal item is in the inventory, the planner reports
// the goal stuck, or MAX_STEPS ticks have run.

const { getAllVisibleBlocks, getInventory, getVitals, getWorldState } = require('../mineflayer_apis/perception_utils')
const { nextAction, familyOf } = require('./planner')
const { executeStep, countItem } = require('./actor')

const AGENT_SYSTEM = `You are the brain of a Minecraft bot. You do NOT invent actions: you pick one of the numbered candidate actions below and explain your choice in one sentence. Reply with JSON only, exactly {"action": <number>, "reasoning": "<one sentence>"}. The candidates are already verified executable by the game-graph planner; your job is judgment between them (e.g. which tree to chop first), not planning from scratch.`

function perceive(bot) {
  const visible = getAllVisibleBlocks(bot)
  const inventory = getInventory(bot)
  const vitals = getVitals(bot)
  const world = getWorldState(bot)
  return { visible, inventory, vitals, world }
}

function summarizeInventory(inventory) {
  const counts = {}
  for (const item of inventory) counts[item.name] = (counts[item.name] || 0) + item.count
  return counts
}

function summarizeVisible(visible, limit = 12) {
  const counts = {}
  for (const block of visible) counts[block.name] = (counts[block.name] || 0) + 1
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, n]) => `${name} x${n}`)
}

/**
 * Build the grounded candidate list for this tick. The planner's next step
 * is always candidate 0; later plan steps that are mine ops for blocks
 * visible nearby become alternatives (e.g. a birch tree when the plan says
 * oak), so the LLM has a real choice without ever leaving the plan.
 */
function buildCandidates(action, perception) {
  const candidates = [{ ...action, label: describeStep(action) }]
  if (action.type === 'stuck' || action.type === 'done') return candidates
  const visibleNames = new Set(perception.visible.map((b) => b.name))
  const seen = new Set([`${action.type}:${action.block || action.item}`])
  for (const step of action.plan || []) {
    if (candidates.length >= 3) break
    if (step.type !== 'mine') continue
    if (!visibleNames.has(step.block)) continue
    const key = `mine:${step.block}`
    if (seen.has(key)) continue
    seen.add(key)
    candidates.push({ ...step, label: describeStep(step) })
  }
  return candidates
}

function describeStep(step) {
  if (step.type === 'mine') return `mine ${step.count || 1}x ${step.block}`
  if (step.type === 'craft') return `craft ${step.count || 1}x ${step.item}`
  if (step.type === 'done') return 'goal already achieved'
  return `stuck: ${step.reason || 'no plan'}`
}

/** Ask the LLM to choose, or fall back to the planner's step. */
async function decide({ llm, goal, perception, candidates, plan }) {
  const demo = { index: 0, action: candidates[0], reasoning: 'demo mode: planner step', via: 'demo' }
  if (!llm) return demo
  const inventory = summarizeInventory(perception.inventory)
  const user = [
    `Goal: ${goal}`,
    `Inventory: ${JSON.stringify(inventory)}`,
    `Visible nearby: ${summarizeVisible(perception.visible).join(', ') || 'nothing'}`,
    `Health: ${perception.vitals.health}/${perception.vitals.maxHealth}, food: ${perception.vitals.food}`,
    `Plan (next steps): ${(plan || []).slice(0, 5).map(describeStep).join(' -> ') || 'none'}`,
    'Candidates:',
    ...candidates.map((c, i) => `  ${i}. ${c.label}`),
  ].join('\n')
  try {
    const raw = await llm.complete({ system: AGENT_SYSTEM, user })
    const parsed = JSON.parse(raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim())
    const index = Number(parsed.action)
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
      return { ...demo, reasoning: `LLM chose invalid index (${JSON.stringify(parsed.action)}); fell back to planner step`, via: 'demo-fallback' }
    }
    return { index, action: candidates[index], reasoning: String(parsed.reasoning || ''), via: 'llm' }
  } catch (err) {
    return { ...demo, reasoning: `LLM call failed (${err.message}); fell back to planner step`, via: 'demo-fallback' }
  }
}

/**
 * Run the agent loop against a connected bot.
 *
 * @param {object} bot - mineflayer bot (already spawned)
 * @param {object} opts - { graph, goal, maxSteps, llm|null, log, perceiveFn, executeFn }
 *   perceiveFn / executeFn are injectable for the offline test harness.
 * @returns {Promise<{ok: boolean, reason: string, steps: number, actions: object[]}>}
 */
async function runAgent(bot, opts) {
  const {
    graph,
    goal,
    maxSteps = 60,
    llm = null,
    log = () => {},
    perceiveFn = perceive,
    executeFn = executeStep,
  } = opts
  const state = { tablePosition: null, excludedFamilies: new Set() }
  const actions = []
  // A table may already be placed in the world from an earlier run; reuse
  // it instead of planning a new one.
  if (typeof bot.findBlock === 'function') {
    try {
      const table = bot.findBlock({ matching: (b) => b.name === 'crafting_table', maxDistance: 6 })
      if (table) state.tablePosition = table.position.clone()
    } catch { /* no table nearby; the planner will craft one */ }
  }
  // Stop only on the SAME action failing repeatedly: varying failures mean
  // the agent is still narrowing its options (excluding families), not stuck.
  let lastFailedLabel = null
  let sameFailures = 0

  for (let tick = 0; tick < maxSteps; tick++) {
    const perception = perceiveFn(bot)
    const inventory = summarizeInventory(perception.inventory)

    if ((inventory[goal] || 0) > 0) {
      const result = { ok: true, reason: `goal achieved: ${goal} x${inventory[goal]}`, steps: tick, actions }
      log({ type: 'agent-result', ...result })
      return result
    }

    const action = nextAction(goal, inventory, graph, {
      stations: { crafting_table: Boolean(state.tablePosition) },
      excludeFamilies: state.excludedFamilies,
    })
    if (action.type === 'done') {
      const result = { ok: true, reason: `goal achieved: ${goal}`, steps: tick, actions }
      log({ type: 'agent-result', ...result })
      return result
    }
    if (action.type === 'stuck') {
      const result = { ok: false, reason: action.reason, steps: tick, actions }
      log({ type: 'agent-result', ...result })
      return result
    }

    const candidates = buildCandidates(action, perception)
    const decision = await decide({ llm, goal, perception, candidates, plan: action.plan })

    const execResult = await executeFn(bot, decision.action, state)
    // Inventory updates from the server lag a tick behind the action;
    // give them a moment to arrive so the next perception is accurate.
    if (typeof bot.waitForTicks === 'function') {
      try { await bot.waitForTicks(10) } catch { /* ignore */ }
    }
    const after = countItem(bot, goal)

    const record = {
      type: 'agent-tick',
      tick,
      goal,
      via: decision.via,
      action: decision.action.label || describeStep(decision.action),
      reasoning: decision.reasoning,
      execOk: execResult.ok,
      execDetail: execResult.reason || (execResult.mined !== undefined ? `mined ${execResult.mined}` : ''),
      inventory: summarizeInventory(perception.inventory),
      goalCount: after,
    }
    actions.push(record)
    log(record)

    if (!execResult.ok) {
      // A failed mine means that block is not nearby — but ONLY when the
      // failure is an absence ("no X within N blocks"). A path or dig
      // failure does not mean the block is absent, so it must not exclude
      // the family, or one bad path kills the only route to the goal.
      if (decision.action.type === 'mine' && decision.action.block &&
          execResult.reason && /\bno .* within \d+ blocks/.test(execResult.reason)) {
        state.excludedFamilies.add(familyOf(decision.action.block))
      }
      // Stop only when the same action fails three times in a row.
      const label = decision.action.label || describeStep(decision.action)
      sameFailures = label === lastFailedLabel ? sameFailures + 1 : 1
      lastFailedLabel = label
      if (sameFailures >= 3) {
        const result = { ok: false, reason: `action failed 3 times in a row: ${label} (${execResult.reason || 'unknown'})`, steps: tick + 1, actions }
        log({ type: 'agent-result', ...result })
        return result
      }
    } else {
      lastFailedLabel = null
      sameFailures = 0
    }
  }

  const result = { ok: false, reason: `max steps (${maxSteps}) reached without ${goal}`, steps: maxSteps, actions }
  log({ type: 'agent-result', ...result })
  return result
}

module.exports = { runAgent, perceive, summarizeInventory, buildCandidates, describeStep, decide, AGENT_SYSTEM }
