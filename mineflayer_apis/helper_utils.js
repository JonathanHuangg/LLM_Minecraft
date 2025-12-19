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