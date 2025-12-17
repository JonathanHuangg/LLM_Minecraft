const Vec3 = require('vec3')

function getEyePosition(bot) {
  return bot.entity.position.offset(0, bot.entity.height, 0)
}

function wrapToPi(value) {
  while (value > Math.PI) value -= 2 * Math.PI
  while (value <= -Math.PI) value += 2 * Math.PI
  return value
}

function dirFromYawPitch(yaw, pitch) {
  // Minecraft convention (Mineflayer): yaw rotates around Y, pitch up/down
  return new Vec3(
    -Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch)
  )
}


// single raycast
function raycastBlock(bot, origin, yaw, pitch, maxDist) {
  const direction = dirFromYawPitch(yaw, pitch)

    const matchSolid = (block) => block && block.boundingBox === 'block' && block.name !== 'air'
    const hit = bot.world.raycast(origin, direction, maxDist, matchSolid)
    if (!hit) return null
    return {
        position: hit.position,
        distance: origin.distanceTo(hit.position),
        face: hit.face
    }

}

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

module.exports = { getAllVisibleBlocks }
