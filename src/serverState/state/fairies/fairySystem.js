const {
  MAX_FAIRIES,
  FAIRY_COLORS,
} = require('../constants');

/**
 * Initializes fairies near random platforms.
 * Why: Keep the same ambient effect as the Python server.
 * @param {{platforms: Array<{x:number,y:number,w:number,h:number}>}} input
 * @returns {Array<any>}
 */
function initializeFairies(input) {
  if (!Array.isArray(input.platforms) || input.platforms.length === 0) {
    return [];
  }

  const fairiesToCreate = Math.min(MAX_FAIRIES, input.platforms.length);

  /** @type {Array<any>} */
  const fairies = [];

  for (let i = 0; i < fairiesToCreate; i += 1) {
    const platform = input.platforms[Math.floor(Math.random() * input.platforms.length)];
    const color = FAIRY_COLORS[Math.floor(Math.random() * FAIRY_COLORS.length)];

    fairies.push({
      id: i,
      x: platform.x + randomBetween(-20, platform.w + 20),
      y: platform.y + randomBetween(-30, -5),
      vx: randomBetween(-1, 1),
      vy: randomBetween(-0.5, 0.5),
      target_platform: platform,
      color,
      wander_offset: randomBetween(0, Math.PI * 2),
      wander_speed: randomBetween(1, 3),
    });
  }

  return fairies;
}

/**
 * Updates fairy positions.
 * @param {{fairies: Array<any>, dt: number}} input
 * @returns {void}
 */
function updateFairies(input) {
  for (const fairy of input.fairies) {
    fairy.wander_offset += fairy.wander_speed * input.dt;

    const wanderRadius = 30;
    const targetX =
      fairy.target_platform.x +
      fairy.target_platform.w / 2 +
      Math.cos(fairy.wander_offset) * wanderRadius;

    const targetY =
      fairy.target_platform.y +
      Math.sin(fairy.wander_offset * 0.7) * 15 -
      20;

    const dx = targetX - fairy.x;
    const dy = targetY - fairy.y;

    fairy.vx = dx * 2.0;
    fairy.vy = dy * 2.0;

    fairy.x += fairy.vx * input.dt;
    fairy.y += fairy.vy * input.dt;

    fairy.x += randomBetween(-5, 5) * input.dt;
    fairy.y += randomBetween(-3, 3) * input.dt;
  }
}

/**
 * Random float in [min, max].
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

module.exports = { initializeFairies, updateFairies };
