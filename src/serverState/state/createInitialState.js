const fs = require('fs');
const path = require('path');

const {
  TILE_SIZE,
  PLAYER_MAX_HEALTH,
  DEAD_BODY_DURATION,
} = require('./constants');

const { loadEnemyCatalog } = require('../../enemies/catalog');
const { initializeFairies } = require('./fairies/fairySystem');
const { ensureSoulState } = require('./souls/soulSystem');
const { ensureChestState } = require('./chests/chestSystem');
const { resetEnemiesForState } = require('../enemies/runtime');
const { buildPlatformGrid } = require('./platformGrid/buildPlatformGrid');
const { buildPlatformsFromMap } = require('./platforms/buildPlatformsFromMap');
const { buildPlatformNavigation } = require('./platformNavigation/buildPlatformNavigation');

function hydrateState(state) {
  if (!state || state._hydrated) {
    return;
  }

  const mapData = state._mapData;
  if (!mapData) {
    state._hydrated = true;
    return;
  }

  const platforms = buildPlatformsFromMap(mapData);
  state.platforms = platforms;
  state.platformGrid = buildPlatformGrid({ platforms });
  state.platformNavigation = buildPlatformNavigation({ platforms });
  state.enemyDefinitions = loadEnemyCatalog({ staticDir: state.config.staticDir });
  state.fairies = initializeFairies({ platforms });

  ensureSoulState(state);
  ensureChestState(state);
  resetEnemiesForState({ state });

  state._hydrated = true;
}

function dehydrateState(state) {
  if (!state || !state._hydrated) {
    return;
  }

  state.platforms = [];
  state.platformGrid = null;
  state.platformNavigation = null;
  state.enemyDefinitions = null;
  state.fairies = [];
  state.enemySpawns = [];
  if (state.enemies?.clear) state.enemies.clear();

  state._hydrated = false;
}

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
    _mapData: mapData,
    _hydrated: false,
    players: new Map(),
    deadBodies: new Map(),
    deadBodyDurationSeconds: DEAD_BODY_DURATION,
    fireballs: new Map(),
    explosions: new Map(),
    nextFireballId: 0,
    nextExplosionId: 0,
    stateSeq: 0,
    platforms: [],
    platformGrid: null,
    platformNavigation: null,
    mapBounds,
    currentMapName: String(mapData.name ?? 'default'),
    spawnPoints,
    enemyDefinitions: null,
    enemySpawns: [],
    enemies: new Map(),
    spawnPointIndex: 0,
    fairies: [],
    souls: new Map(),
    nextSoulId: 1,
    maxHealth: PLAYER_MAX_HEALTH,
    dataDir,
    lastActivePlayerAtMs: Date.now(),
    groups: new Map(),
    pendingGroupInvites: new Map(),
    activeHealings: new Map(),
    chests: new Map(),
    nextChestId: 1,
    nextChestSpawnAtMs: Date.now() + 30_000,
  };
  return state;
}

module.exports = { createInitialState, hydrateState, dehydrateState };
