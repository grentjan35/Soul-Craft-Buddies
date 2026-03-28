const fs = require('fs');
const path = require('path');

const {
  TILE_SIZE,
  GRID_CELL_SIZE,
  PLAYER_MAX_HEALTH,
  DEAD_BODY_DURATION,
} = require('./constants');

const { initializeFairies } = require('./fairies/fairySystem');

/**
 * Loads map JSON if present.
 * @param {{dataDir: string, mapName: string}} input
 * @returns {{ok: true, mapData: any} | {ok: false, reason: string}}
 */
function loadMapFromDisk(input) {
  const mapPath = path.join(input.dataDir, `${input.mapName}.json`);
  if (!fs.existsSync(mapPath)) {
    return { ok: false, reason: 'Map not found' };
  }

  try {
    const raw = fs.readFileSync(mapPath, 'utf8');
    return { ok: true, mapData: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: 'Map unreadable' };
  }
}

/**
 * Converts tile map data into platform AABBs.
 * @param {{tiles: number[][], width: number, height: number}} mapData
 * @returns {Array<{x: number, y: number, w: number, h: number, tile_type: number}>}
 */
function tilesToPlatforms(mapData) {
  /** @type {Array<{x: number, y: number, w: number, h: number, tile_type: number}>} */
  const platforms = [];

  for (let y = 0; y < mapData.height; y += 1) {
    for (let x = 0; x < mapData.width; x += 1) {
      const tileType = mapData.tiles?.[y]?.[x];
      if (typeof tileType === 'number' && tileType >= 0) {
        platforms.push({
          x: x * TILE_SIZE,
          y: y * TILE_SIZE,
          w: TILE_SIZE,
          h: TILE_SIZE,
          tile_type: tileType,
        });
      }
    }
  }

  return platforms;
}

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
 * Creates initial in-memory state.
 * @param {{config: any}} input
 * @returns {any}
 */
function createInitialState(input) {
  const dataDir = input.config.dataDir;

  const mapResult = loadMapFromDisk({ dataDir, mapName: 'default' });
  const mapData = mapResult.ok
    ? mapResult.mapData
    : {
        name: 'default',
        width: 25,
        height: 18,
        tiles: Array.from({ length: 18 }, () =>
          Array.from({ length: 25 }, () => -1)
        ),
        spawnPoints: [{ x: 100, y: 500, id: 0 }],
      };

  const platforms = tilesToPlatforms(mapData);

  const mapBounds = {
    min_x: 0,
    max_x: mapData.width * TILE_SIZE,
    min_y: 0,
    max_y: mapData.height * TILE_SIZE,
  };

  const spawnPoints = Array.isArray(mapData.spawnPoints)
    ? mapData.spawnPoints
    : [{ x: 100, y: 500, id: 0 }];

  return {
    config: input.config,
    players: new Map(),
    deadBodies: new Map(),
    deadBodyDurationSeconds: DEAD_BODY_DURATION,
    fireballs: new Map(),
    explosions: new Map(),
    nextFireballId: 0,
    stateSeq: 0,
    platforms,
    platformGrid: buildPlatformGrid({ platforms }),
    mapBounds,
    spawnPoints,
    spawnPointIndex: 0,
    fairies: initializeFairies({ platforms }),
    maxHealth: PLAYER_MAX_HEALTH,
    dataDir,
  };
}

module.exports = { createInitialState };
