const {
  PLAYER_MAX_HEALTH,
  ATTACK_DURATION,
  FIREBALL_POWER_MIN,
  FIREBALL_POWER_MAX,
  FIREBALL_MAX_DISTANCE,
  GRAVITY,
} = require('../state/constants');
const { pickSpawnPoint } = require('./spawn/pickSpawnPoint');
const { dropSoulsForPlayerDeath, serializeSoulsForState } = require('../state/souls/soulSystem');
const { resolveCharacterSelection } = require('./characters/loadCharacters');
const { despawnEnemiesSpawnedForPlayer, resetEnemiesForState } = require('../enemies/runtime');
const {
  applyUpgradeSelection,
  clampPlayerHealthToMax,
  collectAchievementReward,
  createPlayerProgression,
  getPlayerRunStats,
  isPlayerDrafting,
  markAchievementsRead,
  recordProgressionMetric,
  resetPlayerProgression,
} = require('../state/progression/system');
const { emitProgressionNotification } = require('../state/progression/notifications');

/**
 * Registers all Socket.IO event handlers for a connected client.
 * @param {{socket: import('socket.io').Socket, io: import('socket.io').Server, state: any}} input
 * @returns {void}
 */
function registerSocketHandlers(input) {
  const { socket, io, state } = input;

  handleConnect({ socket, io, state });

  socket.on('disconnect', () => {
    handleDisconnect({ socket, io, state });
  });

  socket.on('player_ready', () => {
    const player = state.players.get(socket.id);
    if (!player) return;
    player.is_ready = true;
  });

  socket.on('input', (data) => {
    const player = state.players.get(socket.id);
    if (!player || !player.is_ready) return;
    if (isPlayerDrafting(player)) {
      player.inputs = { left: false, right: false, up: false };
      return;
    }
    const nextInputs = {
      left: Boolean(data?.left),
      right: Boolean(data?.right),
      up: Boolean(data?.up),
    };

    if (
      player.inputs.left === nextInputs.left &&
      player.inputs.right === nextInputs.right &&
      player.inputs.up === nextInputs.up
    ) {
      return;
    }

    player.inputs = nextInputs;
  });

  socket.on('jump', () => {
    const player = state.players.get(socket.id);
    if (!player || !player.is_ready) return;
    if (isPlayerDrafting(player)) return;
    const runStats = getPlayerRunStats(player);
    if (player.jumps_remaining > 0) {
      player.vy = Number.isFinite(runStats.jumpVelocity) ? runStats.jumpVelocity : -12 * 60;
      player.on_ground = false;
      player.jumps_remaining -= 1;
      const unlockedAchievements = recordProgressionMetric(player, 'jumps', 1);
      for (const achievement of unlockedAchievements) {
        emitProgressionNotification(io, socket.id, achievement);
      }
    }
  });

  socket.on('chat_message', (data) => {
    const player = state.players.get(socket.id);
    if (!player || !player.is_ready) return;

    const messageRaw = String(data?.message ?? '').trim();
    if (!messageRaw) return;

    const message = messageRaw.length > 50 ? messageRaw.slice(0, 50) : messageRaw;

    const forbiddenWords = ['fuck', 'shit', 'cunt', 'bitch', 'ass'];
    const messageLower = message.toLowerCase();
    for (const word of forbiddenWords) {
      if (messageLower.includes(word)) return;
    }

    io.emit('chat_message', {
      sid: socket.id,
      name: String(player.name ?? `P${socket.id.slice(0, 4)}`),
      message,
      timestamp: Date.now(),
    });
  });

  socket.on('respawn_request', () => {
    const player = state.players.get(socket.id);
    if (!player) return;
    if (!player.is_dying) return;

    const nowMs = Date.now();
    const now = nowMs / 1000;
    state.deadBodies.set(`${socket.id}_${Math.floor(now)}`, {
      sid: socket.id,
      name: String(player.name ?? `P${socket.id.slice(0, 4)}`),
      x: player.x,
      y: player.y,
      vy: player.vy,
      on_ground: player.on_ground,
      character: player.character,
      direction: player.direction,
      timestamp: now,
    });

    respawnPlayer({ socketId: socket.id, state });
    io.emit('player_respawned', { sid: socket.id });
  });

  socket.on('projectile_fire', (data) => {
    const player = state.players.get(socket.id);
    if (!player || !player.is_ready) return;
    if (isPlayerDrafting(player)) return;

    const runStats = getPlayerRunStats(player);
    const attackDuration = Math.max(0.18, Number(runStats.attackDuration) || ATTACK_DURATION);

    const nowMs = Date.now();
    const now = nowMs / 1000;
    if (player.is_attacking && now - (player.attack_start_time ?? 0) < attackDuration) {
      return;
    }

    player.is_attacking = true;
    player.attack_start_time = now;
    player.action = 'attack';

    const requestedDx = Number(data?.dx);
    const requestedDy = Number(data?.dy);
    const requestedDistance = Number(data?.distance);
    const maxRange = Math.max(96, Math.min(Number(runStats.fireballRange) || FIREBALL_MAX_DISTANCE, FIREBALL_MAX_DISTANCE));
    const targetDistance = Number.isFinite(requestedDistance)
      ? Math.max(48, Math.min(requestedDistance, maxRange))
      : maxRange;
    const fallbackAngle = typeof data?.angle === 'number' ? data.angle : 0;
    const targetDx = Number.isFinite(requestedDx) ? requestedDx : Math.cos(fallbackAngle) * targetDistance;
    const targetDy = Number.isFinite(requestedDy) ? requestedDy : Math.sin(fallbackAngle) * targetDistance;
    const angle = Math.atan2(targetDy, targetDx);
    player.direction = targetDx >= 0 ? 'right' : 'left';

    const distanceRatio = Math.max(0, Math.min(1, targetDistance / FIREBALL_MAX_DISTANCE));
    const speedScale = Math.max(0.35, Number(runStats.fireballSpeedMultiplier) || 1);
    const referenceSpeed = (FIREBALL_POWER_MIN + (FIREBALL_POWER_MAX - FIREBALL_POWER_MIN) * distanceRatio) * speedScale;
    const effectiveSpeed = referenceSpeed * 2.35;
    const flightTime = Math.max(0.16, Math.min(targetDistance / Math.max(220, effectiveSpeed), 0.62));
    const gravityPerSecond = GRAVITY * 60 * Math.max(0.25, Number(runStats.fireballGravityScale) || 1);
    const vx = targetDx / flightTime;
    const vy = (targetDy - 0.5 * gravityPerSecond * flightTime * flightTime) / flightTime;
    player.pending_projectile_angle = angle;
    player.pending_projectile_vx = vx;
    player.pending_projectile_vy = vy;
  });

  socket.on('select_upgrade', (data) => {
    const player = state.players.get(socket.id);
    if (!player || !player.is_ready) return;

    const cardId = String(data?.cardId ?? '').trim();
    if (!cardId) return;

    const result = applyUpgradeSelection(player, cardId);
    if (!result.ok) {
      socket.emit('upgrade_selection_error', { message: result.reason });
    }
  });

  socket.on('mark_achievements_seen', () => {
    const player = state.players.get(socket.id);
    if (!player) return;
    markAchievementsRead(player);
  });

  socket.on('collect_achievement_reward', (data) => {
    const player = state.players.get(socket.id);
    if (!player || !player.is_ready) return;

    const achievementId = String(data?.achievementId ?? '').trim();
    if (!achievementId) return;

    const result = collectAchievementReward(player, achievementId);
    if (!result.ok) {
      socket.emit('achievement_collect_error', { message: result.reason });
      return;
    }

    socket.emit('achievement_reward_collected', {
      achievementId,
      gainedXp: result.gainedXp,
      rewardXp: result.rewardXp,
      achievement: result.achievement,
    });
  });

  socket.on('load_map', (data) => {
    handleLoadMap({ socket, io, state, data });
  });

  socket.on('client_runtime_error', (data) => {
    const player = state.players.get(socket.id);
    const label = player
      ? `${String(player.name ?? `P${socket.id.slice(0, 4)}`)} (${socket.id.slice(0, 6)})`
      : `Unknown (${socket.id.slice(0, 6)})`;
    const errorType = String(data?.type ?? 'client-error');
    const message = String(data?.message ?? 'Unknown client error');
    const source = data?.source ? ` source=${String(data.source)}` : '';
    const line = Number.isFinite(data?.line) ? ` line=${data.line}` : '';
    const column = Number.isFinite(data?.column) ? ` column=${data.column}` : '';
    const stack = data?.stack ? `\n${String(data.stack)}` : '';

    console.error(`[client-runtime-error] ${label} ${errorType}: ${message}${source}${line}${column}${stack}`);
  });
}

/**
 * Handles connect initialization.
 * @param {{socket: import('socket.io').Socket, io: import('socket.io').Server, state: any}} input
 */
function handleConnect(input) {
  const nameQuery = input.socket.handshake?.query?.name;
  const characterQuery = input.socket.handshake?.query?.character;
  const playerName = String(nameQuery ?? `Player_${input.socket.id.slice(0, 4)}`).slice(0, 15);

  const characterInfo = resolveCharacterSelection({
    state: input.state,
    requestedCharacter: characterQuery,
  });
  const character = characterInfo.character;

  const spawnPoint = pickSpawnPoint({ state: input.state });

  input.state.players.set(input.socket.id, {
    name: playerName,
    x: spawnPoint.x,
    y: spawnPoint.y,
    vx: 0,
    vy: 0,
    knockback_vx: 0,
    on_ground: false,
    inputs: { left: false, right: false, up: false },
    action: 'idle',
    direction: 'right',
    frame: 0,
    is_ready: false,
    jumps_remaining: 2,
    character,
    health: PLAYER_MAX_HEALTH,
    is_dying: false,
    death_time: 0,
    is_attacking: false,
    attack_start_time: 0,
    pending_projectile_angle: null,
    pending_projectile_vx: 0,
    pending_projectile_vy: 0,
    soul_count: 0,
    progression: createPlayerProgression(),
  });
  clampPlayerHealthToMax(input.state.players.get(input.socket.id));

  const now = Date.now() / 1000;
  /** @type {Record<string, any>} */
  const activeDeadBodies = {};
  for (const [sid, body] of input.state.deadBodies.entries()) {
    if (now - body.timestamp < input.state.deadBodyDurationSeconds) {
      activeDeadBodies[sid] = body;
    }
  }

  if (Object.keys(activeDeadBodies).length > 0) {
    input.socket.emit('initial_dead_bodies', activeDeadBodies);
  }

  const activeSouls = serializeSoulsForState(input.state);
  if (Object.keys(activeSouls).length > 0) {
    input.socket.emit('initial_souls', activeSouls);
  }

  input.socket.emit('character_assigned', { character });
}

/**
 * Handles disconnect cleanup.
 * @param {{socket: import('socket.io').Socket, io: import('socket.io').Server, state: any}} input
 */
function handleDisconnect(input) {
  const player = input.state.players.get(input.socket.id);
  if (!player) return;

  const now = Date.now() / 1000;
  const deathData = {
    sid: input.socket.id,
    name: String(player.name ?? `P${input.socket.id.slice(0, 4)}`),
    x: player.x,
    y: player.y,
    vy: player.vy,
    on_ground: player.on_ground,
    character: player.character,
    direction: player.direction,
    timestamp: now,
  };

  dropSoulsForPlayerDeath(input.state, input.io, player);
  despawnEnemiesSpawnedForPlayer(input.state, input.socket.id);
  input.state.deadBodies.set(input.socket.id, deathData);
  input.io.emit('player_dying', deathData);
  input.state.players.delete(input.socket.id);
}

/**
 * Respawns a player onto a random valid platform with reset health.
 * @param {{socketId: string, state: any}} input
 */
function respawnPlayer(input) {
  const player = input.state.players.get(input.socketId);
  if (!player) return;

  const spawn = pickSpawnPoint({ state: input.state });

  player.x = spawn.x;
  player.y = spawn.y;
  player.vx = 0;
  player.vy = 0;
  player.knockback_vx = 0;
  player.on_ground = false;
  player.jumps_remaining = 2;
  resetPlayerProgression(player);
  player.health = Math.max(1, Math.round(getPlayerRunStats(player).maxHealth || PLAYER_MAX_HEALTH));
  player.is_dying = false;
  player.death_time = 0;
  player.is_attacking = false;
  player.attack_start_time = 0;
  player.pending_projectile_angle = null;
  player.pending_projectile_vx = 0;
  player.pending_projectile_vy = 0;
  player.soul_count = 0;
}

/**
 * Handles map loading from disk and broadcasting to all clients.
 * @param {{socket: import('socket.io').Socket, io: import('socket.io').Server, state: any, data: any}} input
 */
function handleLoadMap(input) {
  const fs = require('fs');
  const path = require('path');
  const { TILE_SIZE } = require('../state/constants');
  const { buildPlatformGrid } = require('../state/platformGrid/buildPlatformGrid');
  const { buildPlatformNavigation } = require('../state/platformNavigation/buildPlatformNavigation');
  const { buildPlatformsFromMap } = require('../state/platforms/buildPlatformsFromMap');
  const { initializeFairies } = require('../state/fairies/fairySystem');
  const { loadEnemyCatalog } = require('../../enemies/catalog');

  const mapName = String(input.data?.name ?? 'default');
  const isSameMap = input.state.currentMapName === mapName;
  const mapPath = path.join(input.state.dataDir, `${mapName}.json`);
  if (!fs.existsSync(mapPath)) {
    return;
  }

  const mapData = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

  const tiles = mapData.tiles;
  const mapWidth = mapData.width;
  const mapHeight = mapData.height;
  const platforms = buildPlatformsFromMap(mapData);

  input.state.platforms = platforms;
  input.state.platformGrid = buildPlatformGrid({ platforms });
  input.state.platformNavigation = buildPlatformNavigation({ platforms });
  input.state.fairies = initializeFairies({ platforms });
  input.state.currentMapName = mapName;
  input.state.mapBounds = {
    min_x: 0,
    max_x: mapWidth * TILE_SIZE,
    min_y: 0,
    max_y: mapHeight * TILE_SIZE,
  };

  input.state.spawnPoints = Array.isArray(mapData.spawnPoints)
    ? mapData.spawnPoints
    : [{ x: 100, y: 500, id: 0 }];
  input.state.enemyDefinitions = loadEnemyCatalog({ staticDir: input.state.config.staticDir });
  input.state.enemySpawns = [];
  resetEnemiesForState({ state: input.state });

  const player = input.state.players.get(input.socket.id);
  if (player) {
    const spawn = pickSpawnPoint({ state: input.state });
    player.x = spawn.x;
    player.y = spawn.y;
    player.vx = 0;
    player.vy = 0;
    player.knockback_vx = 0;
    player.on_ground = false;
  }

  const payload = {
    name: mapName,
    width: mapWidth,
    height: mapHeight,
    tiles,
    spawnPoints: input.state.spawnPoints,
    backgrounds: Array.isArray(mapData.backgrounds) ? mapData.backgrounds : [],
    enemies: input.state.enemySpawns,
    decor: Array.isArray(mapData.decor) ? mapData.decor : [],
  };

  if (isSameMap) {
    input.socket.emit('map_loaded', payload);
    return;
  }

  input.io.emit('map_loaded', payload);
}

module.exports = { registerSocketHandlers };
