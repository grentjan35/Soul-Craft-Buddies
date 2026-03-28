const { GRID_CELL_SIZE } = require('../constants');

/**
 * Builds spatial partition grid for platforms.
 * @param {{platforms: Array<{x: number, y: number, w: number, h: number}>}} input
 * @returns {Map<string, Array<any>>}
 */
function buildPlatformGrid(input) {
  /** @type {Map<string, Array<any>>} */
  const grid = new Map();

  for (const plat of input.platforms) {
    const startGx = Math.floor(plat.x / GRID_CELL_SIZE);
    const endGx = Math.floor((plat.x + plat.w) / GRID_CELL_SIZE);
    const startGy = Math.floor(plat.y / GRID_CELL_SIZE);
    const endGy = Math.floor((plat.y + plat.h) / GRID_CELL_SIZE);

    for (let gx = startGx; gx <= endGx; gx += 1) {
      for (let gy = startGy; gy <= endGy; gy += 1) {
        const key = `${gx},${gy}`;
        const list = grid.get(key) ?? [];
        list.push(plat);
        grid.set(key, list);
      }
    }
  }

  return grid;
}

/**
 * Returns nearby platforms in a 3x3 area.
 * @param {{platformGrid: Map<string, Array<any>>, x: number, y: number}} input
 * @returns {Array<any>}
 */
function getNearbyPlatforms(input) {
  const gridX = Math.floor(input.x / GRID_CELL_SIZE);
  const gridY = Math.floor(input.y / GRID_CELL_SIZE);

  /** @type {Array<any>} */
  const nearby = [];

  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const key = `${gridX + dx},${gridY + dy}`;
      const list = input.platformGrid.get(key);
      if (Array.isArray(list)) {
        nearby.push(...list);
      }
    }
  }

  if (nearby.length === 0) {
    return [];
  }

  const seen = new Set();
  /** @type {Array<any>} */
  const unique = [];
  for (const p of nearby) {
    const k = `${p.x},${p.y},${p.w},${p.h}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push(p);
  }

  return unique;
}

module.exports = { buildPlatformGrid, getNearbyPlatforms };
