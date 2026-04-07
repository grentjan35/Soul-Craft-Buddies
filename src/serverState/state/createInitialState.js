const fs = require('fs');
const path = require('path');

const {
  TILE_SIZE,
  PLAYER_MAX_HEALTH,
  DEAD_BODY_DURATION,
} = require('./constants');

const { loadEnemyCatalog } = require('../../enemies/catalog');
const { initializeFairies } = require('./fairies/fairySystem');
const { resetEnemiesForState } = require('../enemies/runtime');
const { buildPlatformGrid } = require('./platformGrid/buildPlatformGrid');
const { buildPlatformsFromMap } = require('./platforms/buildPlatformsFromMap');
const { buildPlatformNavigation } = require('./platformNavigation/buildPlatformNavigation');

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
 * Creates initial in-memory state.
 * @param {{config: any}} input
 * @returns {any}
 */
function createInitialState(input) {
  const dataDir = input.config.dataDir;
  const enemyDefinitions = loadEnemyCatalog({ staticDir: input.config.staticDir });

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
        enemies: [],
      };

  const platforms = buildPlatformsFromMap(mapData);

  const mapBounds = {
    min_x: 0,
    max_x: mapData.width * TILE_SIZE,
    min_y: 0,
    max_y: mapData.height * TILE_SIZE,
  };

  const spawnPoints = Array.isArray(mapData.spawnPoints)
    ? mapData.spawnPoints
    : [{ x: 100, y: 500, id: 0 }];
  const state = {
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
    platformNavigation: buildPlatformNavigation({ platforms }),
    mapBounds,
    currentMapName: String(mapData.name ?? 'default'),
    spawnPoints,
    enemyDefinitions,
    enemySpawns: [],
    enemies: new Map(),
    spawnPointIndex: 0,
    fairies: initializeFairies({ platforms }),
    maxHealth: PLAYER_MAX_HEALTH,
    dataDir,
  };

  resetEnemiesForState({ state });
  return state;
}

module.exports = { createInitialState };
