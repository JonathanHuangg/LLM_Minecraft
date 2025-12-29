const Vec3 = require('vec3')

// --- Functions for Vision 

// liDAR scan sweep
function getAllVisibleBlocks(
  bot,
  {
    maxDist = 64,
    hfovDeg = 90,
    vfovDeg = 60,
    yawStep = 2.0,
    pitchStep = 2.0,
    includeAir = false
  } = {}
) {
  const hfov = hfovDeg * (Math.PI / 180)
  const vfov = vfovDeg * (Math.PI / 180)
  const yawStepRad = yawStep * (Math.PI / 180)
  const pitchStepRad = pitchStep * (Math.PI / 180)

  const eye = getEyePosition(bot)
  const currYaw = bot.entity.yaw
  const currPitch = bot.entity.pitch

  const seen = new Set()
  const visibleBlocks = []

  for (let pitchProbe = -vfov / 2; pitchProbe <= vfov / 2; pitchProbe += pitchStepRad) {
    const pitch = currPitch + pitchProbe

    for (let yawProbe = -hfov / 2; yawProbe <= hfov / 2; yawProbe += yawStepRad) {
      const yaw = wrapToPi(currYaw + yawProbe)

      const hit = raycastBlock(bot, eye, yaw, pitch, maxDist)
      if (!hit || !hit.position) continue

      const block = bot.blockAt(hit.position)
      if (!block) continue
      if (!includeAir && block.name === 'air') continue

      const pos = block.position
      const key = `${pos.x},${pos.y},${pos.z}`
      if (seen.has(key)) continue
      seen.add(key)

      block._lidar = { distance: hit.distance, face: hit.face }
      visibleBlocks.push(block)
    }
  }

  return visibleBlocks
}

function getInventory(bot) {
  return bot.inventory.items().map(item => ({
    slot: item.slot,
    name: item.name,
    count: item.count,
    type: item.type,
    metadata: item.metadata
  }))
}

// i think inventory does this already
function getEquipment(bot) {
  return null
}

function getVitals(bot) {
  return {
    health: bot.health,
    maxHealth: bot.maxHealth,
    food: bot.food,
    saturation: bot.foodSaturation, 
  }
}

function getWorldState(bot) {
  return {
    dimension: bot.game.dimension,
    timeOfDay: bot.time.time,
    day: Math.floor(bot.time.age / 24000),
    position: {
      x: bot.entity.position.x,
      y: bot.entity.position.y,
      z: bot.entity.position.z
    },
    isNight: bot.time.time >= 13000 && bot.time.time <= 23000
  }
}
module.exports = { getAllVisibleBlocks }
