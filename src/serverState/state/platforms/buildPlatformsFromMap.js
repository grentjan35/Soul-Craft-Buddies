const { TILE_SIZE } = require('../constants');

/**
 * Converts tile map data into merged platform strips.
 * @param {{tiles: number[][], width: number, height: number}} mapData
 * @returns {Array<{x: number, y: number, w: number, h: number, tile_type: number}>}
 */
function buildPlatformsFromMap(mapData) {
  const tiles = mapData?.tiles;
  const mapWidth = Number(mapData?.width) || 0;
  const mapHeight = Number(mapData?.height) || 0;

  /** @type {Array<{x: number, y: number, w: number, h: number, tile_type: number}>} */
  const platforms = [];

  for (let y = 0; y < mapHeight; y += 1) {
    let runStartX = -1;
    let runTileType = -1;

    for (let x = 0; x <= mapWidth; x += 1) {
      const tileType = x < mapWidth ? tiles?.[y]?.[x] : -1;
      const isSolid = typeof tileType === 'number' && tileType >= 0;

      if (isSolid && runStartX === -1) {
        runStartX = x;
        runTileType = tileType;
        continue;
      }

      const shouldFlushRun = runStartX !== -1 && (!isSolid || tileType !== runTileType);
      if (!shouldFlushRun) {
        continue;
      }

      platforms.push({
        x: runStartX * TILE_SIZE,
        y: y * TILE_SIZE,
        w: (x - runStartX) * TILE_SIZE,
        h: TILE_SIZE,
        tile_type: runTileType,
      });

      runStartX = isSolid ? x : -1;
      runTileType = isSolid ? tileType : -1;
    }
  }

  return platforms;
}

module.exports = { buildPlatformsFromMap };
