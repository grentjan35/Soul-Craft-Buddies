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

/**
 * Applies map-derived fields onto state.
 * Why: Keep map parsing/loading separate so we can defer disk load until first player.
 * @param {any} state
 * @param {any} mapData
 * @returns {void}
 */
function applyMapDataToState(state, mapData) {
  if (!state) {
    return;
  }

  const safeMapData = mapData || { name: String(state._mapName || 'default'), width: 1, height: 1, spawnPoints: [] };
  state._mapData = mapData;

  const width = Math.max(1, Number(safeMapData.width) || 1);
  const height = Math.max(1, Number(safeMapData.height) || 1);

  state.mapBounds = {
    min_x: 0,
    max_x: width * TILE_SIZE,
    min_y: 0,
    max_y: height * TILE_SIZE,
  };

  const spawnPoints = Array.isArray(safeMapData.spawnPoints) && safeMapData.spawnPoints.length > 0
    ? safeMapData.spawnPoints
    : [{ x: 100, y: 500, id: 0 }];
  state.spawnPoints = spawnPoints;
  state.currentMapName = String(safeMapData.name ?? 'default');
}

/**
 * Ensures state has map data loaded.
 * Why: Avoid holding large map JSON in memory while the server is idle.
 * @param {any} state
 * @returns {void}
 */
function ensureMapDataLoaded(state) {
  if (!state || state._mapData) {
    return;
  }

  const dataDir = state.dataDir || state.config?.dataDir;
  const mapName = String(state._mapName || 'default');
  if (!dataDir) {
    applyMapDataToState(state, null);
    return;
  }

  const mapResult = loadMapFromDisk({ dataDir, mapName });
  if (mapResult.ok) {
    applyMapDataToState(state, mapResult.mapData);
    return;
  }

  applyMapDataToState(state, {
    name: mapName,
    width: 25,
    height: 18,
    tiles: Array.from({ length: 18 }, () => Array.from({ length: 25 }, () => -1)),
    spawnPoints: [{ x: 100, y: 500, id: 0 }],
    enemies: [],
  });
}

function hydrateState(state) {
  if (!state || state._hydrated) {
    return;
  }

  ensureMapDataLoaded(state);
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

  // Release the largest idle memory holder (map JSON) when nobody is playing.
  // Input: 0 players, server idle. We can reload from disk on next hydrate.
  state._mapData = null;

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

  const state = {
    config: input.config,
    // Defer map JSON loading until first player connects.
    // Why: baseline RSS on Railway/Render is sensitive to large parsed objects.
    _mapData: null,
    _mapName: 'default',
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
    mapBounds: { min_x: 0, max_x: 25 * TILE_SIZE, min_y: 0, max_y: 18 * TILE_SIZE },
    currentMapName: 'default',
    spawnPoints: [{ x: 100, y: 500, id: 0 }],
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

  // Keep derived fields consistent without loading the full map at startup.
  applyMapDataToState(state, null);
  return state;
}

module.exports = { createInitialState, hydrateState, dehydrateState };
