const Vec3 = require('vec3')

function getEyePosition(player) {
    return player.entity.position.offset(0, player.entity.height, 0)
}

