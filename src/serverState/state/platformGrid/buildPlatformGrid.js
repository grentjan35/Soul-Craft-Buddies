const { GRID_CELL_SIZE } = require('../constants');

/**
 * Builds spatial partition grid for platforms.
 * @param {{platforms: Array<{x: number, y: number, w: number, h: number}>}} input
 * @returns {Map<number, Map<number, Array<any>>>}
 */
function buildPlatformGrid(input) {
  /** @type {Map<number, Map<number, Array<any>>>} */
  const grid = new Map();

  for (const plat of input.platforms) {
    const startGx = Math.floor(plat.x / GRID_CELL_SIZE);
    const endGx = Math.floor((plat.x + plat.w) / GRID_CELL_SIZE);
    const startGy = Math.floor(plat.y / GRID_CELL_SIZE);
    const endGy = Math.floor((plat.y + plat.h) / GRID_CELL_SIZE);

    for (let gx = startGx; gx <= endGx; gx += 1) {
      let column = grid.get(gx);
      if (!column) {
        column = new Map();
        grid.set(gx, column);
      }

      for (let gy = startGy; gy <= endGy; gy += 1) {
        const list = column.get(gy) ?? [];
        list.push(plat);
        column.set(gy, list);
      }
    }
  }

  return grid;
}

/**
 * Returns nearby platforms in a 3x3 area.
 * @param {{platformGrid: Map<number, Map<number, Array<any>>>, x: number, y: number}} input
 * @returns {Array<any>}
 */
function getNearbyPlatforms(input) {
  const gridX = Math.floor(input.x / GRID_CELL_SIZE);
  const gridY = Math.floor(input.y / GRID_CELL_SIZE);

  /** @type {Set<any>} */
  const nearby = new Set();

  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const column = input.platformGrid.get(gridX + dx);
      const list = column?.get(gridY + dy);
      if (Array.isArray(list)) {
        for (const platform of list) {
          nearby.add(platform);
        }
      }
    }
  }

  if (nearby.size === 0) {
    return [];
  }
  return Array.from(nearby);
}

module.exports = { buildPlatformGrid, getNearbyPlatforms };
