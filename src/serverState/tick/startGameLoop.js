const {
  FRAME_TIME,
  FIREBALL_RADIUS,
  FIREBALL_POWER_MAX,
  FIREBALL_DAMAGE,
  FIREBALL_LIFETIME,
  FIREBALL_MAX_DISTANCE,
  EXPLOSION_DURATION,
  EXPLOSION_RADIUS,
  SPECIAL_BEAM_RANGE,
  SPECIAL_BEAM_WIDTH,
  SPECIAL_BEAM_DAMAGE,
  SPECIAL_BEAM_TICK_INTERVAL,
  ATTACK_DURATION,
  GRAVITY,
  MOVE_SPEED,
  PLAYER_HITBOX_WIDTH,
  PLAYER_HITBOX_HEIGHT,
  PLAYER_MAX_HEALTH,
} = require('../state/constants');
const { HealingSystem } = require('../healing/healingSystem');
const { emitToNearbyPlayers } = require('../replication/nearby');
const { getNearbyPlatforms } = require('../state/platformGrid/buildPlatformGrid');
const {
  checkFireballEnemyCollision,
  damageEnemy,
  despawnEnemiesSpawnedForPlayer,
  getEnemyHitbox,
  serializeEnemiesForState,
  syncEnemyDirector,
  updateEnemies,
} = require('../enemies/runtime');
const { updateFairies } = require('../state/fairies/fairySystem');
const {
  dropSoulsForPlayerDeath,
  serializeSoulsForState,
  updateSouls,
} = require('../state/souls/soulSystem');
const { pickSpawnPoint } = require('../sockets/spawn/pickSpawnPoint');
const {
  consumeAggroUnlockNotification,
  gainPlayerXp,
  getPlayerLevel,
  getSoulDominionPayload,
  getPlayerProgressionPayload,
  getPlayerRunStats,
  isPlayerDrafting,
  recordProgressionMetric,
  resetPlayerProgression,
} = require('../state/progression/system');
const { emitProgressionNotification } = require('../state/progression/notifications');

const ACTIVE_WORLD_SLEEP_DELAY_MS = 30000;
const ENEMY_WAKE_RADIUS_X = 1200;
const ENEMY_WAKE_RADIUS_Y = 850;
const ENEMY_SEND_RADIUS_X = 1500;
const ENEMY_SEND_RADIUS_Y = 1000;
const FIREBALL_SEND_RADIUS_X = 1750;
const FIREBALL_SEND_RADIUS_Y = 1200;
const EXPLOSION_SEND_RADIUS_X = 1800;
const EXPLOSION_SEND_RADIUS_Y = 1250;
const SPECIAL_BEAM_PADDING = SPECIAL_BEAM_WIDTH * 0.5;
const ENEMY_FULL_SYNC_INTERVAL_MS = 750;
const ENEMY_STICKY_FIELD_EXTRA_SENDS = 3;
const ENEMY_STICKY_FIELDS = new Set([
  'x',
  'y',
  'vx',
  'vy',
  'on_ground',
  'direction',
  'action',
  'brain_state',
  'state_started_at_ms',
  'health',
  'max_health',
  'alive',
  'death_time_ms',
  'despawn_at_ms',
  'respawn_at_ms',
  'target_sid',
  'attached_sid',
  'gargoyle_mode',
  'stealth_broken',
  'render_opacity',
  'striker_slam_impacted_at_ms',
]);

function getPlayerKillXp(victim, killer = null) {
  const victimLevel = Math.max(1, getPlayerLevel(victim));
  const killerLevel = killer ? Math.max(1, getPlayerLevel(killer)) : 1;
  const levelGapBonus = Math.max(0, victimLevel - killerLevel) * 4;
  return Math.max(36, 28 + victimLevel * 6 + levelGapBonus);
}

function isHitFromBehind(target, sourceX) {
  if (!target || !Number.isFinite(sourceX)) {
    return false;
  }

  const facing = target.direction === 'left' ? 'left' : 'right';
  return facing === 'right'
    ? sourceX < target.x
    : sourceX > target.x;
}

function getRearHitDamageMultiplier({ ownerType, ownerSid, targetSid, target, sourceX }) {
  if (ownerType !== 'player' || !ownerSid || ownerSid === targetSid) {
    return 1;
  }

  return isHitFromBehind(target, sourceX) ? 1.35 : 1;
}

function resetSpecialBeamState(player) {
  player.special_beam_requested = false;
  player.special_beam_active = false;
  player.special_beam_target_x = 0;
  player.special_beam_target_y = 0;
  player.special_beam_from_x = 0;
  player.special_beam_from_y = 0;
  player.special_beam_to_x = 0;
  player.special_beam_to_y = 0;
  player.special_beam_started_at = 0;
  player.special_beam_damage_accumulator = 0;
}

/** @type {NodeJS.Timeout | null} */
let gameLoopInterval = null;
/** @type {{io: import('socket.io').Server, state: any, healingSystem: HealingSystem} | null} */
let gameLoopContext = null;

/**
 * Starts the physics + broadcast loop.
 * Why: mirror Python (physics ~60Hz, broadcast ~20Hz).
 * @param {{io: import('socket.io').Server, state: any}} input
 * @returns {void}
 */

/**
 * Cleans up expired dead bodies.
 * Why: New players should only receive recent dead body animations.
 * @param {{state: any}} input
 */
function cleanupDeadBodies(input) {
  const nowSec = Date.now() / 1000;

  for (const [key, body] of input.state.deadBodies.entries()) {
    if (!body || typeof body.timestamp !== 'number') {
      input.state.deadBodies.delete(key);
      continue;
    }
    if (nowSec - body.timestamp > input.state.deadBodyDurationSeconds) {
      input.state.deadBodies.delete(key);
    }
  }
}

/**
 * Respawns dying players after 2 seconds.
 * Why: Python server shows death animation then respawns.
 * @param {{state: any, io: import('socket.io').Server}} input
 */
function updateDeathsAndRespawns(input) {
  const nowSec = Date.now() / 1000;

  for (const [sid, p] of input.state.players.entries()) {
    if (!p.is_dying) continue;
    if (nowSec - (p.death_time ?? 0) < 2.0) continue;

    const deathData = {
      sid,
      name: String(p.name ?? `P${sid.slice(0, 4)}`),
      x: p.x,
      y: p.y,
      vy: p.vy,
      on_ground: p.on_ground,
      character: p.character,
      direction: p.direction,
      timestamp: nowSec,
    };

    input.state.deadBodies.set(`${sid}_${Math.floor(nowSec)}`, deathData);
    input.io.emit('player_dying', deathData);

    const spawn = pickSpawnPoint({ state: input.state });
    p.x = spawn.x;
    p.y = spawn.y;
    p.vx = 0;
    p.vy = 0;
    resetPlayerProgression(p);
    p.health = Math.max(1, Math.round(getPlayerRunStats(p).maxHealth || PLAYER_MAX_HEALTH));
    p.is_dying = false;
    p.death_time = 0;
    p.is_attacking = false;
    p.attack_start_time = 0;
    resetSpecialBeamState(p);
    p.pending_projectile_angle = null;
    p.pending_projectile_vx = 0;
    p.pending_projectile_vy = 0;
    p.queued_projectile_angle = null;
    p.queued_projectile_vx = 0;
    p.queued_projectile_vy = 0;
    p.queued_projectile_direction = null;
    p.soul_count = 0;

    input.io.emit('player_respawned', { sid });
  }
}

function applyPassivePlayerRegeneration(input) {
  const dt = Number(input.dt) || 0;
  if (dt <= 0) {
    return;
  }

  for (const p of input.state.players.values()) {
    if (p.is_dying) {
      continue;
    }

    const runStats = getPlayerRunStats(p);
    const regenPerSecond = Math.max(0, Number(runStats.regainPerSecond) || 0);
    if (regenPerSecond <= 0) {
      continue;
    }

    const maxHealth = Math.max(1, Math.round(runStats.maxHealth || PLAYER_MAX_HEALTH));
    if (p.health >= maxHealth) {
      continue;
    }

    p.health = Math.min(maxHealth, p.health + regenPerSecond * dt);
  }
}
function startGameLoop(input) {
  let lastTimeMs = Date.now();
  let lastBroadcastMs = Date.now();
  let lastFairyBroadcastMs = 0;
  // A slightly higher server snapshot rate gives interpolation more samples
  // to work with and noticeably reduces remote movement snapping.
  const broadcastIntervalMs = 1000 / 30;
  const fairyBroadcastIntervalMs = 250;
  const frameDurationMs = FRAME_TIME * 1000;

  input.state.lastActivePlayerAtMs = Date.now();
  const healingSystem = new HealingSystem(input.state);
  gameLoopContext = { ...input, healingSystem };

  const tick = () => {
    gameLoopInterval = null;
    const nowMs = Date.now();
    let dt = (nowMs - lastTimeMs) / 1000;
    lastTimeMs = nowMs;

    dt = Math.min(dt, 0.1);

    const activePlayers = getActivePlayers(input.state);
    const worldSleeping = shouldSleepWorld(input.state, nowMs, activePlayers);

    // Stop game loop if no players connected
    if (input.state.players.size === 0) {
      stopGameLoop();
      return;
    }

    if (!worldSleeping) {
      updateGameState({ state: input.state, dt, io: input.io });
      updateEnemies({
        state: input.state,
        dt,
        io: input.io,
        spawnFireball,
        shouldUpdateEnemy: (enemy) => isEnemyNearAnyPlayer(enemy, activePlayers),
      });
      updateSpecialBeams({ state: input.state, dt, io: input.io });
      syncEnemyDirector(input.state, input.io);
      updateFairies({ fairies: input.state.fairies, dt });
      updateSouls({ state: input.state, dt, io: input.io });
      updateFireballs({ state: input.state, dt, io: input.io });
      updateExplosions({ state: input.state, io: input.io });
      updateDeathsAndRespawns({ state: input.state, io: input.io });
      applyPassivePlayerRegeneration({ state: input.state, dt });
      cleanupDeadBodies({ state: input.state });
      
      const healEvents = healingSystem.update(dt);
      if (healEvents.length > 0) {
        input.io.emit('healing_update', { events: healEvents });
      }
    }

    if (nowMs - lastBroadcastMs >= broadcastIntervalMs) {
      lastBroadcastMs = nowMs;
      const includeFairies = nowMs - lastFairyBroadcastMs >= fairyBroadcastIntervalMs;
      if (includeFairies) {
        lastFairyBroadcastMs = nowMs;
      }
      broadcastState({
        io: input.io,
        state: input.state,
        includeFairies,
        activePlayers,
        worldSleeping,
      });
    }

    const tickWorkDurationMs = Date.now() - nowMs;
    const nextDelayMs = Math.max(0, frameDurationMs - tickWorkDurationMs);
    gameLoopInterval = setTimeout(tick, nextDelayMs);
  };

  gameLoopInterval = setTimeout(tick, frameDurationMs);
}

/**
 * Broadcasts current state.
 * @param {{io: import('socket.io').Server, state: any, includeFairies?: boolean, activePlayers?: any[], worldSleeping?: boolean}} input
 */
function broadcastState(input) {
  // Skip broadcast if no connected clients
  if (input.io.sockets.sockets.size === 0) {
    return;
  }

  input.state.stateSeq += 1;
  const ts = Date.now();

  /** @type {Record<string, any>} */
  const playersPayload = {};
  for (const [sid, p] of input.state.players.entries()) {
    if (p.is_dying) continue;
    const runStats = getPlayerRunStats(p);
    const soulDominion = getSoulDominionPayload(p);
    playersPayload[sid] = {
      name: p.name,
      level: Math.max(1, getPlayerLevel(p)),
      x: round1(p.x),
      y: round1(p.y),
      vy: round1(p.vy),
      action: p.action,
      direction: p.direction,
      on_ground: p.on_ground,
      character: p.character,
      health: p.health,
      max_health: Math.max(1, Math.round(runStats.maxHealth || PLAYER_MAX_HEALTH)),
      is_attacking: p.is_attacking,
      attack_start_time_ms: p.attack_start_time ? Math.round(p.attack_start_time * 1000) : 0,
      special_beam_active: Boolean(p.special_beam_active),
      special_beam_from_x: round1(p.special_beam_from_x || 0),
      special_beam_from_y: round1(p.special_beam_from_y || 0),
      special_beam_to_x: round1(p.special_beam_to_x || 0),
      special_beam_to_y: round1(p.special_beam_to_y || 0),
      special_beam_started_at_ms: p.special_beam_started_at ? Math.round(p.special_beam_started_at * 1000) : 0,
      soul_count: Math.max(0, Math.round(p.soul_count || 0)),
      soul_title: soulDominion.title,
      soul_short_title: soulDominion.shortTitle,
      soul_tier_index: soulDominion.tierIndex,
      soul_next_threshold: soulDominion.nextThreshold,
      soul_aura_strength: soulDominion.auraStrength,
      soul_accent: soulDominion.accent,
      soul_aura: soulDominion.aura,
    };
  }

  const fairiesPayload = input.includeFairies
    ? input.state.fairies.map((fairy) => ({
        id: fairy.id,
        x: round1(fairy.x),
        y: round1(fairy.y),
        vx: round1(fairy.vx),
        vy: round1(fairy.vy),
        color: fairy.color,
      }))
    : undefined;
  const soulsPayload = serializeSoulsForState(input.state);
  const basePayload = {
    ts,
    seq: input.state.stateSeq,
    players: playersPayload,
    fairies: fairiesPayload,
    souls: soulsPayload,
    world_sleeping: Boolean(input.worldSleeping),
  };

  if (input.state.players.size === 0) {
    input.io.volatile.emit('state', {
      ...basePayload,
      enemies: {},
      fireballs: {},
      explosions: {},
      enemies_full: true,
    });
    return;
  }

  for (const [sid, player] of input.state.players.entries()) {
    const socket = input.io.sockets.sockets.get(sid);
    if (!socket) {
      continue;
    }

    const enemyReplication = buildEnemyReplicationPayload({
      socket,
      ts,
      state: input.state,
      centerX: player.x,
      centerY: player.y,
      radiusX: ENEMY_SEND_RADIUS_X,
      radiusY: ENEMY_SEND_RADIUS_Y,
    });
    const fireballsPayload = serializeFireballsForState(input.state, {
      centerX: player.x,
      centerY: player.y,
      radiusX: FIREBALL_SEND_RADIUS_X,
      radiusY: FIREBALL_SEND_RADIUS_Y,
    });
    const explosionsPayload = serializeExplosionsForState(input.state, ts, {
      centerX: player.x,
      centerY: player.y,
      radiusX: EXPLOSION_SEND_RADIUS_X,
      radiusY: EXPLOSION_SEND_RADIUS_Y,
    });

    socket.volatile.emit('state', {
      ...basePayload,
      self: {
        progression: getPlayerProgressionPayload(player),
      },
      fireballs: fireballsPayload,
      explosions: explosionsPayload,
      enemies: enemyReplication.enemies,
      enemies_full: enemyReplication.full,
      enemy_removed: enemyReplication.removed,
    });
  }
}

function serializeFireballsForState(state, options = {}) {
  /** @type {Record<string, any>} */
  const payload = {};
  const centerX = Number(options.centerX);
  const centerY = Number(options.centerY);
  const radiusX = Math.max(0, Number(options.radiusX) || 0);
  const radiusY = Math.max(0, Number(options.radiusY) || 0);
  const useFilter = Number.isFinite(centerX) && Number.isFinite(centerY) && radiusX > 0 && radiusY > 0;

  for (const [id, f] of state.fireballs.entries()) {
    if (!f.active) {
      continue;
    }
    if (
      useFilter &&
      (Math.abs(f.x - centerX) > radiusX || Math.abs(f.y - centerY) > radiusY)
    ) {
      continue;
    }

    payload[id] = {
      owner_sid: f.owner_sid,
      owner_type: f.owner_type ?? 'player',
      owner_enemy_id: f.owner_enemy_id ?? null,
      x: round1(f.x),
      y: round1(f.y),
      vx: round1(f.vx),
      vy: round1(f.vy),
      start_x: round1(f.start_x),
      start_y: round1(f.start_y),
      initial_vx: round1(f.initial_vx ?? f.vx),
      initial_vy: round1(f.initial_vy ?? f.vy),
      spawn_time_ms: f.spawn_time_ms ?? Math.round((f.spawn_time ?? 0) * 1000),
      render_scale: f.render_scale ?? 1,
      radius_scale: f.radius_scale ?? 1,
      gravity_scale: f.gravity_scale ?? 1,
    };
  }

  return payload;
}

function serializeExplosionsForState(state, ts, options = {}) {
  /** @type {Record<string, any>} */
  const payload = {};
  const centerX = Number(options.centerX);
  const centerY = Number(options.centerY);
  const radiusX = Math.max(0, Number(options.radiusX) || 0);
  const radiusY = Math.max(0, Number(options.radiusY) || 0);
  const useFilter = Number.isFinite(centerX) && Number.isFinite(centerY) && radiusX > 0 && radiusY > 0;
  const nowSec = ts / 1000;

  for (const [id, e] of state.explosions.entries()) {
    if (!e.active) {
      continue;
    }
    if (
      useFilter &&
      (Math.abs(e.x - centerX) > radiusX || Math.abs(e.y - centerY) > radiusY)
    ) {
      continue;
    }

    payload[id] = {
      x: e.x,
      y: e.y,
      radius: e.radius,
      age: round3(nowSec - e.spawn_time),
      spawn_time_ms: e.spawn_time_ms ?? Math.round((e.spawn_time ?? 0) * 1000),
      owner_type: e.owner_type ?? 'player',
      owner_enemy_id: e.owner_enemy_id ?? null,
      owner_enemy_type: e.owner_enemy_type ?? null,
    };
  }

  return payload;
}

/**
 * @param {import('socket.io').Socket} socket
 * @returns {{lastFullSyncAt: number, snapshotsById: Map<string, Record<string, any>>, stickyFieldsById: Map<string, Map<string, number>>}}
 */
function getEnemyReplicationState(socket) {
  if (!socket.data.enemyReplication || typeof socket.data.enemyReplication !== 'object') {
    socket.data.enemyReplication = {
      lastFullSyncAt: 0,
      snapshotsById: new Map(),
      stickyFieldsById: new Map(),
    };
  }

  if (!(socket.data.enemyReplication.snapshotsById instanceof Map)) {
    socket.data.enemyReplication.snapshotsById = new Map();
  }

  if (!(socket.data.enemyReplication.stickyFieldsById instanceof Map)) {
    socket.data.enemyReplication.stickyFieldsById = new Map();
  }

  return socket.data.enemyReplication;
}

/**
 * @param {{socket: import('socket.io').Socket, ts: number, state: any, centerX: number, centerY: number, radiusX: number, radiusY: number}} input
 * @returns {{enemies: Record<string, any>, full: boolean, removed: string[]}}
 */
function buildEnemyReplicationPayload(input) {
  const visibleEnemies = serializeEnemiesForState(input.state, {
    centerX: input.centerX,
    centerY: input.centerY,
    radiusX: input.radiusX,
    radiusY: input.radiusY,
  });
  const replicationState = getEnemyReplicationState(input.socket);
  const sendFullSnapshot =
    replicationState.lastFullSyncAt <= 0 ||
    input.ts - replicationState.lastFullSyncAt >= ENEMY_FULL_SYNC_INTERVAL_MS;
  const nextSnapshotsById = new Map();
  const nextStickyFieldsById = new Map();
  const removed = [];
  const enemies = {};

  for (const [enemyId, snapshot] of Object.entries(visibleEnemies)) {
    const previousSnapshot = replicationState.snapshotsById.get(enemyId);
    const previousStickyFields = replicationState.stickyFieldsById.get(enemyId);
    nextSnapshotsById.set(enemyId, snapshot);

    const payload = buildEnemyDiffPayload(snapshot, previousSnapshot, previousStickyFields, sendFullSnapshot);
    if (payload) {
      const { _stickyFieldState, ...publicPayload } = payload;
      enemies[enemyId] = publicPayload;

      if (_stickyFieldState instanceof Map && _stickyFieldState.size > 0) {
        nextStickyFieldsById.set(enemyId, _stickyFieldState);
      }
    }
  }

  for (const enemyId of replicationState.snapshotsById.keys()) {
    if (!nextSnapshotsById.has(enemyId)) {
      removed.push(enemyId);
    }
  }

  replicationState.snapshotsById = nextSnapshotsById;
  replicationState.stickyFieldsById = nextStickyFieldsById;
  if (sendFullSnapshot) {
    replicationState.lastFullSyncAt = input.ts;
  }

  return {
    enemies: sendFullSnapshot || Object.keys(enemies).length > 0 ? enemies : undefined,
    full: sendFullSnapshot,
    removed: removed.length > 0 ? removed : undefined,
  };
}

/**
 * @param {Record<string, any>} currentSnapshot
 * @param {Record<string, any> | undefined} previousSnapshot
 * @param {Map<string, number> | undefined} previousStickyFields
 * @param {boolean} forceFullSnapshot
 * @returns {Record<string, any> | null}
 */
function buildEnemyDiffPayload(currentSnapshot, previousSnapshot, previousStickyFields, forceFullSnapshot) {
  if (forceFullSnapshot || !previousSnapshot) {
    const fullSnapshot = { ...currentSnapshot };
    if (ENEMY_STICKY_FIELD_EXTRA_SENDS > 0) {
      const stickyFieldState = new Map();
      for (const key of ENEMY_STICKY_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(currentSnapshot, key)) {
          stickyFieldState.set(key, ENEMY_STICKY_FIELD_EXTRA_SENDS);
        }
      }
      if (stickyFieldState.size > 0) {
        fullSnapshot._stickyFieldState = stickyFieldState;
      }
    }
    return fullSnapshot;
  }

  const diff = {};
  const stickyFieldState = previousStickyFields instanceof Map
    ? new Map(previousStickyFields)
    : new Map();
  let changed = false;

  for (const [key, value] of Object.entries(currentSnapshot)) {
    if (previousSnapshot[key] === value) {
      continue;
    }

    diff[key] = value;
    changed = true;

    if (ENEMY_STICKY_FIELDS.has(key) && ENEMY_STICKY_FIELD_EXTRA_SENDS > 0) {
      stickyFieldState.set(key, ENEMY_STICKY_FIELD_EXTRA_SENDS);
    }
  }

  for (const [key, remainingSends] of stickyFieldState.entries()) {
    if (!Object.prototype.hasOwnProperty.call(currentSnapshot, key)) {
      stickyFieldState.delete(key);
      continue;
    }

    if (!Number.isFinite(remainingSends) || remainingSends <= 0) {
      stickyFieldState.delete(key);
      continue;
    }

    diff[key] = currentSnapshot[key];
    changed = true;
    stickyFieldState.set(key, remainingSends - 1);

    if (remainingSends - 1 <= 0) {
      stickyFieldState.delete(key);
    }
  }

  if (!changed) {
    return null;
  }

  if (stickyFieldState.size > 0) {
    diff._stickyFieldState = stickyFieldState;
  }

  return diff;
}

function getActivePlayers(state) {
  const players = [];

  for (const player of state.players.values()) {
    if (!player || player.is_dying || !player.is_ready) {
      continue;
    }
    players.push(player);
  }

  return players;
}

function shouldSleepWorld(state, nowMs, activePlayers) {
  if (activePlayers.length > 0) {
    state.lastActivePlayerAtMs = nowMs;
    return false;
  }

  if (!Number.isFinite(state.lastActivePlayerAtMs)) {
    state.lastActivePlayerAtMs = nowMs;
  }

  return nowMs - state.lastActivePlayerAtMs >= ACTIVE_WORLD_SLEEP_DELAY_MS;
}

function isEnemyNearAnyPlayer(enemy, activePlayers) {
  if (!Array.isArray(activePlayers) || activePlayers.length === 0) {
    return false;
  }

  return activePlayers.some(
    (player) =>
      Math.abs(enemy.x - player.x) <= ENEMY_WAKE_RADIUS_X &&
      Math.abs(enemy.y - player.y) <= ENEMY_WAKE_RADIUS_Y
  );
}

/**
 * Updates players positions and collisions.
 * @param {{state: any, dt: number}} input
 */
function updateGameState(input) {
  const nowSec = Date.now() / 1000;

  for (const [sid, p] of input.state.players.entries()) {
    if (p.is_dying) continue;

    const prevX = p.x;
    const prevY = p.y;
    const runStats = getPlayerRunStats(p);

    const externalVx = Number.isFinite(p.knockback_vx) ? p.knockback_vx : 0;
    p.vx = externalVx;

    const canMove = !(p.is_attacking && p.on_ground) && !isPlayerDrafting(p);

    if (canMove) {
      if (p.inputs?.left) {
        p.vx -= Number.isFinite(runStats.moveSpeed) ? runStats.moveSpeed : MOVE_SPEED;
        if (!p.is_attacking) p.direction = 'left';
      }
      if (p.inputs?.right) {
        p.vx += Number.isFinite(runStats.moveSpeed) ? runStats.moveSpeed : MOVE_SPEED;
        if (!p.is_attacking) p.direction = 'right';
      }
    }

    p.x += p.vx * input.dt;

    const hb = getPlayerHitbox(p);
    clampToBounds({ p, hb, mapBounds: input.state.mapBounds });

    const nearby = getNearbyPlatforms({
      platformGrid: input.state.platformGrid,
      x: p.x,
      y: p.y,
    });

    resolveHorizontalPlatformCollisions({ p, prevX, nearby });

    const yAfterHorizontal = p.y;

    p.vy += GRAVITY * input.dt * 60;
    p.y += p.vy * input.dt;
    p.on_ground = false;

    clampToBounds({ p, hb: getPlayerHitbox(p), mapBounds: input.state.mapBounds });

    resolveVerticalPlatformCollisions({ p, prevY: yAfterHorizontal, nearby });
    resolveEmbeddedPlayerInTerrain({ state: input.state, p, nearby });

    if (p.is_attacking) {
      const attackStart = p.attack_start_time ?? 0;
      const attackDuration = Math.max(0.18, Number(runStats.attackDuration) || ATTACK_DURATION);
      if (nowSec - attackStart >= attackDuration) {
        if (typeof p.pending_projectile_angle === 'number') {
          spawnPlayerFireball({
            state: input.state,
            io: input.io,
            ownerSid: sid,
            player: p,
            angle: p.pending_projectile_angle,
            vx: typeof p.pending_projectile_vx === 'number' ? p.pending_projectile_vx : Math.cos(p.pending_projectile_angle) * FIREBALL_POWER_MAX,
            vy: typeof p.pending_projectile_vy === 'number' ? p.pending_projectile_vy : Math.sin(p.pending_projectile_angle) * FIREBALL_POWER_MAX,
          });
          p.pending_projectile_angle = null;
          p.pending_projectile_vx = 0;
          p.pending_projectile_vy = 0;
        }

        if (typeof p.queued_projectile_angle === 'number') {
          p.is_attacking = true;
          p.attack_start_time = nowSec;
          p.action = 'attack';
          if (p.queued_projectile_direction === 'left' || p.queued_projectile_direction === 'right') {
            p.direction = p.queued_projectile_direction;
          }
          p.pending_projectile_angle = p.queued_projectile_angle;
          p.pending_projectile_vx = Number.isFinite(p.queued_projectile_vx) ? p.queued_projectile_vx : 0;
          p.pending_projectile_vy = Number.isFinite(p.queued_projectile_vy) ? p.queued_projectile_vy : 0;
          p.queued_projectile_angle = null;
          p.queued_projectile_vx = 0;
          p.queued_projectile_vy = 0;
          p.queued_projectile_direction = null;
        } else {
          p.is_attacking = false;
        }
      } else {
        p.action = 'attack';
      }
    }

    if (p.special_beam_active) {
      p.action = 'attack';
    } else if (!p.is_attacking) {
      if (!p.on_ground) p.action = 'jump';
      else if (Math.abs(p.vx) > 0) p.action = 'run';
      else p.action = 'idle';
    }

    p.frame = (Number(p.frame ?? 0) + 1) % 60;
    p.knockback_vx = Math.abs(externalVx) < 18 ? 0 : externalVx * 0.84;

    // Input: [1], Loop index starts at 0 (single player): dying check above prevents updates.
    void prevX;
    void prevY;
    void sid;
  }

  resolvePlayerPlayerCollisions({ state: input.state });
}

function segmentAabbIntersectionT(startX, startY, endX, endY, rect, padding = 0) {
  const minX = rect.x - padding;
  const maxX = rect.x + rect.w + padding;
  const minY = rect.y - padding;
  const maxY = rect.y + rect.h + padding;
  const deltaX = endX - startX;
  const deltaY = endY - startY;
  let tMin = 0;
  let tMax = 1;

  const axes = [
    { start: startX, delta: deltaX, min: minX, max: maxX },
    { start: startY, delta: deltaY, min: minY, max: maxY },
  ];

  for (const axis of axes) {
    if (Math.abs(axis.delta) < 0.000001) {
      if (axis.start < axis.min || axis.start > axis.max) {
        return null;
      }
      continue;
    }

    let t1 = (axis.min - axis.start) / axis.delta;
    let t2 = (axis.max - axis.start) / axis.delta;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }

    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) {
      return null;
    }
  }

  if (tMax < 0 || tMin > 1) {
    return null;
  }

  return Math.max(0, tMin);
}

function computeBeamDistanceToMapBounds(state, originX, originY, dirX, dirY, maxDistance) {
  let distance = maxDistance;

  if (dirX > 0.000001) {
    distance = Math.min(distance, (state.mapBounds.max_x - originX) / dirX);
  } else if (dirX < -0.000001) {
    distance = Math.min(distance, (state.mapBounds.min_x - originX) / dirX);
  }

  if (dirY > 0.000001) {
    distance = Math.min(distance, (state.mapBounds.max_y - originY) / dirY);
  } else if (dirY < -0.000001) {
    distance = Math.min(distance, (state.mapBounds.min_y - originY) / dirY);
  }

  return Math.max(0, distance);
}

function collectBeamCollisionPlatforms(state, originX, originY, endX, endY) {
  const distance = Math.hypot(endX - originX, endY - originY);
  const sampleCount = Math.max(1, Math.ceil(distance / 96));
  const candidates = new Map();

  for (let index = 0; index <= sampleCount; index += 1) {
    const t = index / sampleCount;
    const sampleX = originX + (endX - originX) * t;
    const sampleY = originY + (endY - originY) * t;
    const nearby = getNearbyPlatforms({
      platformGrid: state.platformGrid,
      x: sampleX,
      y: sampleY,
    });

    for (const platform of nearby) {
      const key = `${platform.x}:${platform.y}:${platform.w}:${platform.h}`;
      if (!candidates.has(key)) {
        candidates.set(key, platform);
      }
    }
  }

  return Array.from(candidates.values());
}

function resolveSpecialBeamEndpoint(input) {
  const maxDistance = computeBeamDistanceToMapBounds(
    input.state,
    input.originX,
    input.originY,
    input.dirX,
    input.dirY,
    input.maxDistance
  );
  const unclippedEndX = input.originX + input.dirX * maxDistance;
  const unclippedEndY = input.originY + input.dirY * maxDistance;
  let bestT = 1;
  let hitWall = false;

  const candidates = collectBeamCollisionPlatforms(input.state, input.originX, input.originY, unclippedEndX, unclippedEndY);
  for (const platform of candidates) {
    const hitT = segmentAabbIntersectionT(
      input.originX,
      input.originY,
      unclippedEndX,
      unclippedEndY,
      { x: platform.x, y: platform.y, w: platform.w, h: platform.h }
    );
    if (hitT === null || hitT >= bestT) {
      continue;
    }

    bestT = Math.max(0, hitT - 0.002);
    hitWall = true;
  }

  return {
    x: input.originX + (unclippedEndX - input.originX) * bestT,
    y: input.originY + (unclippedEndY - input.originY) * bestT,
    hitWall,
  };
}

function awardBeamKill(input) {
  if (!input.ownerSid || input.ownerSid === input.victimSid) {
    return;
  }

  const killer = input.state.players.get(input.ownerSid);
  const victim = input.state.players.get(input.victimSid);
  if (!killer || !victim) {
    return;
  }

  const xpResult = gainPlayerXp(killer, getPlayerKillXp(victim, killer));
  const unlockedAggroWarning = consumeAggroUnlockNotification(killer);
  const unlockedAchievements = recordProgressionMetric(killer, 'playerKills', 1);
  const victimName = victim.name || `P${input.victimSid.slice(0, 4)}`;
  const killerName = killer.name || `P${input.ownerSid.slice(0, 4)}`;
  input.io.emit('progression_notification', {
    type: 'player_kill',
    xp: 0,
    message: `${killerName} melted ${victimName} with fire lazer`,
    victimName,
    killerName,
    weapon: 'fire lazer',
  });
  emitProgressionNotification(input.io, input.ownerSid, {
    type: 'player_kill',
    xp: xpResult.gainedXp,
    message: `you melted ${victimName} with fire lazer`,
    caption: `+${xpResult.gainedXp} xp`,
    victimName,
    killerName,
    weapon: 'fire lazer',
  });

  if (unlockedAggroWarning) {
    emitProgressionNotification(input.io, input.ownerSid, unlockedAggroWarning);
  }
  for (const achievement of unlockedAchievements) {
    emitProgressionNotification(input.io, input.ownerSid, achievement);
  }
}

function applySpecialBeamDamage(input) {
  const ownerPlayer = input.ownerSid ? input.state.players.get(input.ownerSid) : null;
  const beamDx = input.endX - input.startX;
  const beamDy = input.endY - input.startY;
  const horizontalSign = Math.sign(beamDx) || (ownerPlayer?.direction === 'left' ? -1 : 1);
  const nowSec = Date.now() / 1000;

  for (const [sid, player] of input.state.players.entries()) {
    if (player.is_dying) continue;
    if (sid === input.ownerSid) continue;
    if (ownerPlayer && arePlayersFriendly(ownerPlayer, player)) continue;

    const hitT = segmentAabbIntersectionT(
      input.startX,
      input.startY,
      input.endX,
      input.endY,
      { x: player.x - PLAYER_HITBOX_WIDTH / 2, y: player.y - PLAYER_HITBOX_HEIGHT / 2, w: PLAYER_HITBOX_WIDTH, h: PLAYER_HITBOX_HEIGHT },
      SPECIAL_BEAM_PADDING
    );
    if (hitT === null) {
      continue;
    }

    const reduction = Math.max(0, Math.min(0.72, Number(getPlayerRunStats(player).damageReduction) || 0));
    const reducedDamage = Math.max(1, Math.round(input.damage * (1 - reduction)));
    const impactX = input.startX + beamDx * hitT;
    const impactY = input.startY + beamDy * hitT;
    player.knockback_vx = horizontalSign * 260;
    player.vy = Math.min(player.vy, -190);
    player.on_ground = false;
    player.jumps_remaining = 0;
    player.health -= reducedDamage;

    if (player.health <= 0) {
      player.health = 0;
      player.is_dying = true;
      player.death_time = nowSec;
      despawnEnemiesSpawnedForPlayer(input.state, sid);
      dropSoulsForPlayerDeath(input.state, input.io, player);
      awardBeamKill({ state: input.state, io: input.io, ownerSid: input.ownerSid, victimSid: sid });
      input.io.emit('player_dying', {
        sid,
        x: player.x,
        y: player.y,
        vy: player.vy,
        on_ground: player.on_ground,
        character: player.character,
        direction: player.direction,
        timestamp: nowSec,
      });
    }

    input.io.emit('player_hit', {
      sid,
      damage: reducedDamage,
      health: player.health,
      is_dying: player.is_dying,
      x: impactX,
      y: impactY,
      effect: 'beam',
    });
  }

  for (const [enemyId, enemy] of input.state.enemies.entries()) {
    if (!enemy.alive) continue;

    const hitbox = getEnemyHitbox(input.state, enemy);
    if (!hitbox) {
      continue;
    }

    const hitT = segmentAabbIntersectionT(
      input.startX,
      input.startY,
      input.endX,
      input.endY,
      { x: hitbox.x, y: hitbox.y, w: hitbox.width, h: hitbox.height },
      SPECIAL_BEAM_PADDING
    );
    if (hitT === null) {
      continue;
    }

    damageEnemy({
      state: input.state,
      io: input.io,
      enemyId,
      damage: input.damage,
      sourceSid: input.ownerSid,
      sourceVx: horizontalSign * 320,
      sourceVy: -140,
    });
  }
}

function updateSpecialBeams(input) {
  for (const [sid, player] of input.state.players.entries()) {
    const wantsBeam =
      Boolean(player.special_beam_requested) &&
      Boolean(player.special_attack_unlocked) &&
      !player.is_dying &&
      player.is_ready &&
      !isPlayerDrafting(player);

    if (!wantsBeam) {
      resetSpecialBeamState(player);
      continue;
    }

    const wasActive = Boolean(player.special_beam_active);
    const originX = player.x + (player.direction === 'left' ? -18 : 18);
    const originY = player.y - 18;
    let dirX = Number(player.special_beam_target_x) - originX;
    let dirY = Number(player.special_beam_target_y) - originY;
    const length = Math.hypot(dirX, dirY);

    if (length < 0.0001) {
      dirX = player.direction === 'left' ? -1 : 1;
      dirY = 0;
    } else {
      dirX /= length;
      dirY /= length;
    }

    player.direction = dirX < 0 ? 'left' : 'right';
    const runStats = getPlayerRunStats(player);
    const beamRange = Math.max(280, Math.min(SPECIAL_BEAM_RANGE, Number(runStats.fireballRange) || SPECIAL_BEAM_RANGE));
    const endpoint = resolveSpecialBeamEndpoint({
      state: input.state,
      originX,
      originY,
      dirX,
      dirY,
      maxDistance: beamRange,
    });

    player.special_beam_active = true;
    if (!player.special_beam_started_at) {
      player.special_beam_started_at = Date.now() / 1000;
    }
    player.special_beam_from_x = originX;
    player.special_beam_from_y = originY;
    player.special_beam_to_x = endpoint.x;
    player.special_beam_to_y = endpoint.y;
    player.action = 'attack';

    if (!wasActive) {
      player.special_beam_damage_accumulator = SPECIAL_BEAM_TICK_INTERVAL;
    } else {
      player.special_beam_damage_accumulator = Math.max(0, Number(player.special_beam_damage_accumulator) || 0) + input.dt;
    }

    const beamDamage = Math.max(
      4,
      Math.round(Math.max(SPECIAL_BEAM_DAMAGE, (Number(runStats.fireballDamage) || SPECIAL_BEAM_DAMAGE) * 0.42))
    );
    while (player.special_beam_damage_accumulator >= SPECIAL_BEAM_TICK_INTERVAL) {
      player.special_beam_damage_accumulator -= SPECIAL_BEAM_TICK_INTERVAL;
      applySpecialBeamDamage({
        state: input.state,
        io: input.io,
        ownerSid: sid,
        startX: originX,
        startY: originY,
        endX: endpoint.x,
        endY: endpoint.y,
        damage: beamDamage,
      });
    }
  }
}

function spawnPlayerFireball(input) {
  const runStats = getPlayerRunStats(input.player);
  const projectileCount = Math.max(1, Math.round(runStats.fireballProjectileCount || 1));
  const spreadDeg = Number(runStats.fireballProjectileSpreadDeg) || 0;
  const baseAngle = Math.atan2(input.vy, input.vx);
  const baseSpeed = Math.max(180, Math.hypot(input.vx, input.vy));
  const critChance = Math.max(0, Math.min(0.95, Number(runStats.fireballCritChance) || 0));
  const critMultiplier = Math.max(1.1, Number(runStats.fireballCritMultiplier) || 1.6);

  for (let index = 0; index < projectileCount; index += 1) {
    const centeredIndex = index - (projectileCount - 1) / 2;
    const angleOffset = projectileCount > 1
      ? centeredIndex * (spreadDeg * Math.PI / 180)
      : 0;
    const angle = baseAngle + angleOffset;
    const crit = Math.random() < critChance;
    const damage = (Number(runStats.fireballDamage) || FIREBALL_DAMAGE) * (crit ? critMultiplier : 1);
    const radiusScale = Math.max(0.35, Number(runStats.fireballRadiusScale) || 1);
    const renderScale = Math.max(0.35, Number(runStats.fireballRenderScale) || 1);

    spawnFireball({
      state: input.state,
      io: input.io,
      ownerType: 'player',
      ownerSid: input.ownerSid,
      x: input.player.x,
      y: input.player.y,
      vx: Math.cos(angle) * baseSpeed,
      vy: Math.sin(angle) * baseSpeed,
      damage,
      renderScale,
      radiusScale,
      gravityScale: Math.max(0.25, Number(runStats.fireballGravityScale) || 1),
      maxDistance: Number(runStats.fireballRange) || FIREBALL_MAX_DISTANCE,
      explosionRadius: Number(runStats.fireballExplosionRadius) || EXPLOSION_RADIUS,
      explosionDamageMultiplier: Number(runStats.fireballExplosionDamageMultiplier) || 1,
      crit,
    });
  }
}

function spawnFireball(input) {
  const nowMs = Date.now();
  const now = nowMs / 1000;
  const fireballId = input.state.nextFireballId;
  input.state.nextFireballId += 1;

  input.state.fireballs.set(fireballId, {
    id: fireballId,
    owner_sid: input.ownerSid ?? null,
    owner_type: input.ownerType ?? 'player',
    owner_enemy_id: input.ownerEnemyId ?? null,
    x: input.x,
    y: input.y,
    vx: input.vx,
    vy: input.vy,
    start_x: input.x,
    start_y: input.y,
    initial_vx: input.vx,
    initial_vy: input.vy,
    distance_traveled: 0,
    spawn_time: now,
    spawn_time_ms: nowMs,
    damage: Math.max(1, Math.round(input.damage ?? FIREBALL_DAMAGE)),
    render_scale: Math.max(0.2, Number(input.renderScale) || 1),
    radius_scale: Math.max(0.2, Number(input.radiusScale) || 1),
    gravity_scale: Math.max(0.25, Number(input.gravityScale) || 1),
    max_distance: Math.max(48, Math.min(Number(input.maxDistance) || FIREBALL_MAX_DISTANCE, FIREBALL_MAX_DISTANCE)),
    explosion_radius: Math.max(12, Number(input.explosionRadius) || EXPLOSION_RADIUS),
    explosion_damage_multiplier: Math.max(0.2, Number(input.explosionDamageMultiplier) || 1),
    crit: Boolean(input.crit),
    active: true,
  });

  emitToNearbyPlayers({
    io: input.io,
    state: input.state,
    x: input.x,
    y: input.y,
    radiusX: FIREBALL_SEND_RADIUS_X,
    radiusY: FIREBALL_SEND_RADIUS_Y,
    event: 'projectile_created',
    payload: {
      id: fireballId,
      owner_sid: input.ownerSid ?? null,
      owner_type: input.ownerType ?? 'player',
      owner_enemy_id: input.ownerEnemyId ?? null,
      x: input.x,
      y: input.y,
      vx: input.vx,
      vy: input.vy,
      start_x: input.x,
      start_y: input.y,
      initial_vx: input.vx,
      initial_vy: input.vy,
      spawn_time_ms: nowMs,
      render_scale: Math.max(0.2, Number(input.renderScale) || 1),
      radius_scale: Math.max(0.2, Number(input.radiusScale) || 1),
      gravity_scale: Math.max(0.25, Number(input.gravityScale) || 1),
      max_distance: Math.max(48, Math.min(Number(input.maxDistance) || FIREBALL_MAX_DISTANCE, FIREBALL_MAX_DISTANCE)),
      explosion_radius: Math.max(12, Number(input.explosionRadius) || EXPLOSION_RADIUS),
      explosion_damage_multiplier: Math.max(0.2, Number(input.explosionDamageMultiplier) || 1),
      crit: Boolean(input.crit),
    },
    includeSids: typeof input.ownerSid === 'string' ? [input.ownerSid] : [],
  });
}

/**
 * Resolves player-player collisions.
 * Why: prevents players from overlapping indefinitely.
 * @param {{state: any}} input
 */
function resolvePlayerPlayerCollisions(input) {
  const ids = Array.from(input.state.players.keys());

  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const p1 = input.state.players.get(ids[i]);
      const p2 = input.state.players.get(ids[j]);
      if (!p1 || !p2) continue;
      if (p1.is_dying || p2.is_dying) continue;

      if (!checkPlayerPlayerCollision({ p1, p2 })) continue;
      pushPlayersApart({ state: input.state, p1, p2 });
    }
  }
}

/**
 * Checks player-player collision using hitboxes.
 * @param {{p1: any, p2: any}} input
 * @returns {boolean}
 */
function checkPlayerPlayerCollision(input) {
  const a = getPlayerHitbox(input.p1);
  const b = getPlayerHitbox(input.p2);

  return (
    a.x < b.x + PLAYER_HITBOX_WIDTH &&
    a.x + PLAYER_HITBOX_WIDTH > b.x &&
    a.y < b.y + PLAYER_HITBOX_HEIGHT &&
    a.y + PLAYER_HITBOX_HEIGHT > b.y
  );
}

/**
 * Pushes two overlapping players apart.
 * @param {{state: any, p1: any, p2: any}} input
 */
function pushPlayersApart(input) {
  const a = getPlayerHitbox(input.p1);
  const b = getPlayerHitbox(input.p2);

  const overlapX = Math.min(a.x + PLAYER_HITBOX_WIDTH - b.x, b.x + PLAYER_HITBOX_WIDTH - a.x);
  const overlapY = Math.min(a.y + PLAYER_HITBOX_HEIGHT - b.y, b.y + PLAYER_HITBOX_HEIGHT - a.y);

  if (overlapX < overlapY) {
    if (a.x < b.x) {
      separatePlayersAlongAxis({
        state: input.state,
        p1: input.p1,
        p2: input.p2,
        axis: 'x',
        delta1: -overlapX / 2,
        delta2: overlapX / 2,
      });
    } else {
      separatePlayersAlongAxis({
        state: input.state,
        p1: input.p1,
        p2: input.p2,
        axis: 'x',
        delta1: overlapX / 2,
        delta2: -overlapX / 2,
      });
    }
    return;
  }

  if (a.y < b.y) {
    const moved = separatePlayersAlongAxis({
      state: input.state,
      p1: input.p1,
      p2: input.p2,
      axis: 'y',
      delta1: -overlapY,
      delta2: 0,
    });
    if (moved.movedP1) {
      input.p1.vy = 0;
      input.p1.on_ground = true;
      input.p1.jumps_remaining = 2;
    }
    return;
  }

  const moved = separatePlayersAlongAxis({
    state: input.state,
    p1: input.p1,
    p2: input.p2,
    axis: 'y',
    delta1: 0,
    delta2: -overlapY,
  });
  if (moved.movedP2) {
    input.p2.vy = 0;
    input.p2.on_ground = true;
    input.p2.jumps_remaining = 2;
  }
}

/**
 * Separates two players while refusing to move either into walls or out of bounds.
 * @param {{state:any, p1:any, p2:any, axis:'x'|'y', delta1:number, delta2:number}} input
 * @returns {{movedP1:boolean, movedP2:boolean}}
 */
function separatePlayersAlongAxis(input) {
  const pairMoveAllowed =
    canMovePlayerBy({ state: input.state, player: input.p1, axis: input.axis, delta: input.delta1 }) &&
    canMovePlayerBy({ state: input.state, player: input.p2, axis: input.axis, delta: input.delta2 });

  if (pairMoveAllowed) {
    applyAxisMove({ player: input.p1, axis: input.axis, delta: input.delta1 });
    applyAxisMove({ player: input.p2, axis: input.axis, delta: input.delta2 });
    return { movedP1: input.delta1 !== 0, movedP2: input.delta2 !== 0 };
  }

  const p1SoloAllowed = canMovePlayerBy({
    state: input.state,
    player: input.p1,
    axis: input.axis,
    delta: input.delta1 - input.delta2,
  });
  if (p1SoloAllowed) {
    applyAxisMove({ player: input.p1, axis: input.axis, delta: input.delta1 - input.delta2 });
    return { movedP1: input.delta1 !== input.delta2, movedP2: false };
  }

  const p2SoloAllowed = canMovePlayerBy({
    state: input.state,
    player: input.p2,
    axis: input.axis,
    delta: input.delta2 - input.delta1,
  });
  if (p2SoloAllowed) {
    applyAxisMove({ player: input.p2, axis: input.axis, delta: input.delta2 - input.delta1 });
    return { movedP1: false, movedP2: input.delta1 !== input.delta2 };
  }

  return { movedP1: false, movedP2: false };
}

/**
 * Checks whether a player can move along one axis without entering terrain.
 * @param {{state:any, player:any, axis:'x'|'y', delta:number}} input
 * @returns {boolean}
 */
function canMovePlayerBy(input) {
  if (input.delta === 0) return true;

  const candidateX = input.axis === 'x' ? input.player.x + input.delta : input.player.x;
  const candidateY = input.axis === 'y' ? input.player.y + input.delta : input.player.y;
  return isPlayerPlacementValid({ state: input.state, player: input.player, x: candidateX, y: candidateY });
}

/**
 * Applies an axis move to a player.
 * @param {{player:any, axis:'x'|'y', delta:number}} input
 */
function applyAxisMove(input) {
  if (input.delta === 0) return;
  if (input.axis === 'x') input.player.x += input.delta;
  else input.player.y += input.delta;
}

/**
 * Returns true when the candidate player center is within bounds and not inside terrain.
 * @param {{state:any, player:any, x:number, y:number}} input
 * @returns {boolean}
 */
function isPlayerPlacementValid(input) {
  const halfW = PLAYER_HITBOX_WIDTH / 2;
  const halfH = PLAYER_HITBOX_HEIGHT / 2;
  const hbX = input.x - halfW;
  const hbY = input.y - halfH;
  const { mapBounds } = input.state;

  if (hbX < mapBounds.min_x) return false;
  if (hbX + PLAYER_HITBOX_WIDTH > mapBounds.max_x) return false;
  if (hbY < mapBounds.min_y) return false;
  if (hbY + PLAYER_HITBOX_HEIGHT > mapBounds.max_y) return false;

  const nearby = getNearbyPlatforms({
    platformGrid: input.state.platformGrid,
    x: input.x,
    y: input.y,
  });
  const candidate = { ...input.player, x: input.x, y: input.y };

  for (const plat of nearby) {
    if (checkPlayerPlatformCollision({ player: candidate, platform: plat })) {
      return false;
    }
  }

  return true;
}

/**
 * Updates fireballs, collisions, damage, and emits events.
 * @param {{state: any, dt: number, io: import('socket.io').Server}} input
 */
function updateFireballs(input) {
  const nowSec = Date.now() / 1000;
  /** @type {Set<number>} */
  const toRemove = new Set();

  for (const [id, f] of input.state.fireballs.entries()) {
    if (!f.active) continue;
    const ownerPlayer = f.owner_type === 'player' && f.owner_sid
      ? input.state.players.get(f.owner_sid)
      : null;

    f.vy += GRAVITY * Math.max(0.25, Number(f.gravity_scale) || 1) * input.dt * 60;
    f.x += f.vx * input.dt;
    f.y += f.vy * input.dt;

    const dx = f.x - f.start_x;
    const dy = f.y - f.start_y;
    f.distance_traveled = Math.sqrt(dx * dx + dy * dy);

    const age = nowSec - f.spawn_time;
    const fireballMaxDistance = Math.max(48, Number(f.max_distance) || FIREBALL_MAX_DISTANCE);
    if (age > FIREBALL_LIFETIME || f.distance_traveled > fireballMaxDistance) {
      toRemove.add(id);
      createExplosion({
        state: input.state,
        io: input.io,
        x: f.x,
        y: f.y,
        ownerSid: f.owner_sid,
        ownerType: f.owner_type,
        ownerEnemyId: f.owner_enemy_id,
        damage: f.damage,
        radius: f.explosion_radius,
        damageMultiplier: f.explosion_damage_multiplier,
        sourceVx: f.vx,
        sourceVy: f.vy,
      });
      continue;
    }

    const nearby = getNearbyPlatforms({
      platformGrid: input.state.platformGrid,
      x: f.x,
      y: f.y,
    });

    if (nearby.some((plat) => checkFireballPlatformCollision({ fireball: f, platform: plat }))) {
      toRemove.add(id);
      createExplosion({
        state: input.state,
        io: input.io,
        x: f.x,
        y: f.y,
        ownerSid: f.owner_sid,
        ownerType: f.owner_type,
        ownerEnemyId: f.owner_enemy_id,
        damage: f.damage,
        radius: f.explosion_radius,
        damageMultiplier: f.explosion_damage_multiplier,
        sourceVx: f.vx,
        sourceVy: f.vy,
      });
      continue;
    }

    for (const [sid, p] of input.state.players.entries()) {
      if (p.is_dying) continue;
      if (f.owner_type !== 'enemy' && sid === f.owner_sid) continue;
      if (ownerPlayer && arePlayersFriendly(ownerPlayer, p)) continue;

      if (checkFireballPlayerCollision({ fireball: f, player: p })) {
        createExplosion({
          state: input.state,
          io: input.io,
          x: f.x,
          y: f.y,
          ownerSid: f.owner_sid,
          ownerType: f.owner_type,
          ownerEnemyId: f.owner_enemy_id,
          damage: f.damage,
          radius: f.explosion_radius,
          damageMultiplier: f.explosion_damage_multiplier,
          directHitSid: sid,
          sourceVx: f.vx,
          sourceVy: f.vy,
        });

        toRemove.add(id);
        break;
      }
    }

    if (toRemove.has(id)) {
      continue;
    }

    if (f.owner_type === 'enemy') {
      continue;
    }

    for (const [enemyId, enemy] of input.state.enemies.entries()) {
      if (!enemy.alive) continue;

      if (checkFireballEnemyCollision(input.state, f, enemy)) {
        createExplosion({
          state: input.state,
          io: input.io,
          x: f.x,
          y: f.y,
          ownerSid: f.owner_sid,
          ownerType: f.owner_type,
          ownerEnemyId: f.owner_enemy_id,
          damage: f.damage,
          radius: f.explosion_radius,
          damageMultiplier: f.explosion_damage_multiplier,
          directHitEnemyId: enemyId,
          sourceVx: f.vx,
          sourceVy: f.vy,
        });
        toRemove.add(id);
        break;
      }
    }
  }

  for (const id of toRemove) {
    if (input.state.fireballs.has(id)) {
      const fireball = input.state.fireballs.get(id);
      input.state.fireballs.delete(id);
      emitToNearbyPlayers({
        io: input.io,
        state: input.state,
        x: Number(fireball?.x),
        y: Number(fireball?.y),
        radiusX: FIREBALL_SEND_RADIUS_X,
        radiusY: FIREBALL_SEND_RADIUS_Y,
        event: 'projectile_destroyed',
        payload: {
          id,
          destroy_time_ms: Date.now(),
          x: fireball?.x,
          y: fireball?.y,
        },
        includeSids: typeof fireball?.owner_sid === 'string' ? [fireball.owner_sid] : [],
      });
    }
  }
}

/**
 * Updates explosions and removes expired ones.
 * @param {{state: any, io: import('socket.io').Server}} input
 */
function updateExplosions(input) {
  const nowSec = Date.now() / 1000;
  const nowMs = Date.now();

  /** @type {string[]} */
  const toRemove = [];
  for (const [id, e] of input.state.explosions.entries()) {
    if (!e.active) continue;
    if (nowSec - e.spawn_time > EXPLOSION_DURATION) {
      toRemove.push(id);
    }
  }

  for (const id of toRemove) {
    if (input.state.explosions.has(id)) {
      const explosion = input.state.explosions.get(id);
      input.state.explosions.delete(id);
      emitToNearbyPlayers({
        io: input.io,
        state: input.state,
        x: Number(explosion?.x),
        y: Number(explosion?.y),
        radiusX: EXPLOSION_SEND_RADIUS_X,
        radiusY: EXPLOSION_SEND_RADIUS_Y,
        event: 'explosion_destroyed',
        payload: { id, destroy_time_ms: nowMs },
        includeSids: typeof explosion?.owner_sid === 'string' ? [explosion.owner_sid] : [],
      });
    }
  }
}

function applyExplosionDamage(input) {
  const nowSec = Date.now() / 1000;
  const radius = Math.max(24, Number(input.radius) || EXPLOSION_RADIUS) * 2.35;
  const ENEMY_EXPLOSION_DIRECT_DAMAGE = Math.max(1, Math.round((input.damage ?? FIREBALL_DAMAGE) * Math.max(0.2, Number(input.damageMultiplier) || 1)));
  const ENEMY_EXPLOSION_SPLASH_MIN_PROXIMITY = 0.28;
  const ownerPlayer = input.ownerSid ? input.state.players.get(input.ownerSid) : null;

  for (const [sid, player] of input.state.players.entries()) {
    if (player.is_dying) continue;
    if (sid === input.ownerSid) continue;
    if (ownerPlayer && arePlayersFriendly(ownerPlayer, player)) continue;

    const dx = player.x - input.x;
    const dy = player.y - input.y;
    const distance = Math.hypot(dx, dy);
    const isDirectHit = sid === input.directHitSid;
    if (!isDirectHit && distance > radius) continue;

    const proximity = isDirectHit ? 1 : Math.max(0, 1 - distance / radius);
    const damage = isDirectHit
      ? ENEMY_EXPLOSION_DIRECT_DAMAGE
      : Math.max(4, Math.round(ENEMY_EXPLOSION_DIRECT_DAMAGE * 0.7 * proximity));
    if (damage <= 0) continue;

    const rearHitMultiplier = getRearHitDamageMultiplier({
      ownerType: input.ownerType,
      ownerSid: input.ownerSid,
      targetSid: sid,
      target: player,
      sourceX: Number.isFinite(input.x) ? input.x : player.x,
    });

    let impulseX = distance > 0.001 ? dx / distance : 0;
    let impulseY = distance > 0.001 ? dy / distance : -1;
    if (isDirectHit && Math.abs(impulseX) < 0.001) {
      const sourceDir = Math.sign(input.sourceVx || 0);
      impulseX = sourceDir !== 0 ? sourceDir : (player.direction === 'left' ? -1 : 1);
      impulseY = -0.45;
    }

    const closeRangeBoost = isDirectHit ? 1 : Math.pow(proximity, 0.4);
    const knockbackScale = isDirectHit ? 1.3 : Math.max(0.3, closeRangeBoost);
    const horizontalKnockback = (isDirectHit ? 980 : 780) * knockbackScale;
    const verticalLaunch = (isDirectHit ? 540 : 320) * Math.max(0.4, closeRangeBoost);
    const upwardBias = isDirectHit ? 0.82 : 0.6;

    player.knockback_vx = impulseX * horizontalKnockback;
    player.vy = Math.min(player.vy, -(verticalLaunch + upwardBias * horizontalKnockback * 0.22) + Math.min(0, impulseY) * 80);
    player.on_ground = false;
    player.jumps_remaining = 0;
    const reduction = Math.max(0, Math.min(0.72, Number(getPlayerRunStats(player).damageReduction) || 0));
    const reducedDamage = Math.max(1, Math.round(damage * rearHitMultiplier * (1 - reduction)));
    player.health -= reducedDamage;

    if (player.health <= 0) {
      player.health = 0;
      player.is_dying = true;
      player.death_time = nowSec;
      despawnEnemiesSpawnedForPlayer(input.state, sid);
      dropSoulsForPlayerDeath(input.state, input.io, player);
      if (input.ownerType === 'player' && input.ownerSid && input.ownerSid !== sid) {
        const killer = input.state.players.get(input.ownerSid);
        if (killer) {
          const xpResult = gainPlayerXp(killer, getPlayerKillXp(player, killer));
          const unlockedAggroWarning = consumeAggroUnlockNotification(killer);
          const unlockedAchievements = recordProgressionMetric(killer, 'playerKills', 1);
          const victimName = player.name || `P${sid.slice(0, 4)}`;
          const killerName = killer.name || `P${input.ownerSid.slice(0, 4)}`;
          // Broadcast player kill to everyone
          input.io.emit('progression_notification', {
            type: 'player_kill',
            xp: 0, // No XP shown to everyone
            message: `${killerName} killed ${victimName} with fireball`,
            victimName,
            killerName,
            weapon: 'fireball',
          });
          // Send XP notification only to the killer
          emitProgressionNotification(input.io, input.ownerSid, {
            type: 'player_kill',
            xp: xpResult.gainedXp,
            message: `you killed ${victimName} with fireball`,
            caption: `+${xpResult.gainedXp} xp`,
            victimName,
            killerName,
            weapon: 'fireball',
          });
          if (unlockedAggroWarning) {
            emitProgressionNotification(input.io, input.ownerSid, unlockedAggroWarning);
          }
          for (const achievement of unlockedAchievements) {
            emitProgressionNotification(input.io, input.ownerSid, achievement);
          }
        }
      }
      input.io.emit('player_dying', {
        sid,
        x: player.x,
        y: player.y,
        vy: player.vy,
        on_ground: player.on_ground,
        character: player.character,
        direction: player.direction,
        timestamp: nowSec,
      });
    }

    input.io.emit('player_hit', {
      sid,
      damage: reducedDamage,
      health: player.health,
      is_dying: player.is_dying,
      x: input.x,
      y: input.y,
    });
  }

  for (const [enemyId, enemy] of input.state.enemies.entries()) {
    if (!enemy.alive || input.ownerType === 'enemy') continue;

    const dx = enemy.x - input.x;
    const dy = enemy.y - input.y;
    const distance = Math.hypot(dx, dy);
    const isDirectHit = enemyId === input.directHitEnemyId;
    if (!isDirectHit && distance > radius) continue;

    const proximity = isDirectHit ? 1 : Math.max(0, 1 - distance / radius);
    if (!isDirectHit && proximity < ENEMY_EXPLOSION_SPLASH_MIN_PROXIMITY) continue;
    const damage = isDirectHit
      ? ENEMY_EXPLOSION_DIRECT_DAMAGE
      : Math.max(6, Math.round(ENEMY_EXPLOSION_DIRECT_DAMAGE * 0.42 * proximity));
    if (damage <= 0) continue;

    let impulseX = distance > 0.001 ? dx / distance : 0;
    let impulseY = distance > 0.001 ? dy / distance : -1;
    if (isDirectHit && Math.abs(impulseX) < 0.001) {
      impulseX = Math.sign(input.sourceVx || 0) || 1;
      impulseY = -0.35;
    }

    const knockbackScale = isDirectHit ? 1.05 : Math.max(0.35, Math.pow(proximity, 0.55));
    const knockbackVx = impulseX * 520 * knockbackScale;
    const knockbackVy = -(190 + 170 * knockbackScale) + Math.min(0, impulseY) * 50;

    damageEnemy({
      state: input.state,
      io: input.io,
      enemyId,
      damage,
      sourceSid: input.ownerSid,
      sourceVx: knockbackVx,
      sourceVy: knockbackVy,
    });
  }
}

/**
 * Creates an explosion.
 * @param {{state: any, io: import('socket.io').Server, x: number, y: number, ownerSid?: string | null, ownerType?: string, ownerEnemyId?: string | null, damage?: number, radius?: number, damageMultiplier?: number, directHitSid?: string, directHitEnemyId?: string, sourceVx?: number, sourceVy?: number}} input
 */
function createExplosion(input) {
  const nowMs = Date.now();
  const id = `exp_${input.state.nextExplosionId}`;
  input.state.nextExplosionId += 1;
  const nowSec = nowMs / 1000;

  const radius = Math.max(12, Number(input.radius) || EXPLOSION_RADIUS);
  const ownerEnemy = input.ownerEnemyId ? input.state.enemies.get(input.ownerEnemyId) : null;
  const ownerEnemyType = input.ownerType === 'enemy'
    ? (ownerEnemy?.type || (String(input.ownerEnemyId || '').startsWith('gargoyle_') ? 'gargoyle' : null))
    : null;
  input.state.explosions.set(id, {
    id,
    x: input.x,
    y: input.y,
    radius,
    spawn_time: nowSec,
    spawn_time_ms: nowMs,
    active: true,
    owner_sid: input.ownerSid ?? null,
    owner_type: input.ownerType ?? 'player',
    owner_enemy_id: input.ownerEnemyId ?? null,
    owner_enemy_type: ownerEnemyType,
  });
  emitToNearbyPlayers({
    io: input.io,
    state: input.state,
    x: input.x,
    y: input.y,
    radiusX: EXPLOSION_SEND_RADIUS_X,
    radiusY: EXPLOSION_SEND_RADIUS_Y,
    event: 'explosion_created',
    payload: {
      id,
      x: input.x,
      y: input.y,
      radius,
      spawn_time_ms: nowMs,
      owner_type: input.ownerType ?? 'player',
      owner_enemy_id: input.ownerEnemyId ?? null,
      owner_enemy_type: ownerEnemyType,
    },
    includeSids: typeof input.ownerSid === 'string' ? [input.ownerSid] : [],
  });
  applyExplosionDamage(input);
}

/**
 * @param {any} playerA
 * @param {any} playerB
 * @returns {boolean}
 */
function arePlayersFriendly(playerA, playerB) {
  if (!playerA || !playerB) {
    return false;
  }

  const groupA = typeof playerA.groupId === 'string' ? playerA.groupId : '';
  const groupB = typeof playerB.groupId === 'string' ? playerB.groupId : '';
  return Boolean(groupA) && groupA === groupB;
}

/**
 * Gets the player hitbox origin.
 * @param {any} p
 * @returns {{x: number, y: number}}
 */
function getPlayerHitbox(p) {
  const halfW = PLAYER_HITBOX_WIDTH / 2;
  const halfH = PLAYER_HITBOX_HEIGHT / 2;
  return { x: p.x - halfW, y: p.y - halfH };
}

/**
 * Returns true when two 1D ranges overlap.
 * @param {number} minA
 * @param {number} maxA
 * @param {number} minB
 * @param {number} maxB
 * @returns {boolean}
 */
function rangesOverlap(minA, maxA, minB, maxB) {
  return minA < maxB && maxA > minB;
}

/**
 * Clamps player within map bounds.
 * @param {{p: any, hb: {x:number,y:number}, mapBounds: any}} input
 */
function clampToBounds(input) {
  const halfW = PLAYER_HITBOX_WIDTH / 2;
  const halfH = PLAYER_HITBOX_HEIGHT / 2;

  if (input.hb.x < input.mapBounds.min_x) {
    input.p.x = input.mapBounds.min_x + halfW;
    input.p.vx = 0;
  } else if (input.hb.x + PLAYER_HITBOX_WIDTH > input.mapBounds.max_x) {
    input.p.x = input.mapBounds.max_x - halfW;
    input.p.vx = 0;
  }

  const hbY = input.p.y - halfH;
  if (hbY < input.mapBounds.min_y) {
    input.p.y = input.mapBounds.min_y + halfH;
    input.p.vy = 0;
  } else if (hbY + PLAYER_HITBOX_HEIGHT > input.mapBounds.max_y) {
    input.p.y = input.mapBounds.max_y - halfH;
    input.p.vy = 0;
    input.p.on_ground = true;
    input.p.jumps_remaining = 2;
  }
}

/**
 * Resolves horizontal platform collisions.
 * @param {{p:any, prevX:number, nearby:any[]}} input
 */
function resolveHorizontalPlatformCollisions(input) {
  const halfW = PLAYER_HITBOX_WIDTH / 2;
  const prevHbX = input.prevX - halfW;

  for (const plat of input.nearby) {
    if (!checkPlayerPlatformCollision({ player: input.p, platform: plat })) continue;

    const wasOutside =
      prevHbX + PLAYER_HITBOX_WIDTH <= plat.x || prevHbX >= plat.x + plat.w;

    if (!wasOutside) continue;

    if (input.p.vx > 0) input.p.x = plat.x - halfW;
    else if (input.p.vx < 0) input.p.x = plat.x + plat.w + halfW;

    input.p.vx = 0;
  }
}

/**
 * Resolves vertical platform collisions.
 * @param {{p:any, prevY:number, nearby:any[]}} input
 */
function resolveVerticalPlatformCollisions(input) {
  const halfH = PLAYER_HITBOX_HEIGHT / 2;
  const halfW = PLAYER_HITBOX_WIDTH / 2;
  const prevHbY = input.prevY - halfH;
  const prevHbX = input.p.x - halfW;
  const prevBottom = prevHbY + PLAYER_HITBOX_HEIGHT;
  const prevTop = prevHbY;

  for (const plat of input.nearby) {
    const currentHb = getPlayerHitbox(input.p);
    const currentBottom = currentHb.y + PLAYER_HITBOX_HEIGHT;
    const currentTop = currentHb.y;
    const currentOverlaps = checkPlayerPlatformCollision({ player: input.p, platform: plat });
    const horizontalOverlap = rangesOverlap(
      Math.min(prevHbX, currentHb.x),
      Math.max(prevHbX + PLAYER_HITBOX_WIDTH, currentHb.x + PLAYER_HITBOX_WIDTH),
      plat.x,
      plat.x + plat.w
    );

    if (input.p.vy > 0 && horizontalOverlap) {
      const crossedPlatformTop = prevBottom <= plat.y && currentBottom >= plat.y;
      if (crossedPlatformTop || currentOverlaps) {
        input.p.y = plat.y - halfH;
        input.p.vy = 0;
        input.p.on_ground = true;
        input.p.jumps_remaining = 2;
        continue;
      }
    }

    if (input.p.vy < 0 && horizontalOverlap) {
      const platformBottom = plat.y + plat.h;
      const crossedPlatformBottom = prevTop >= platformBottom && currentTop <= platformBottom;
      if (crossedPlatformBottom || currentOverlaps) {
        input.p.y = platformBottom + halfH;
        input.p.vy = 0;
      }
    }
  }
}

/**
 * Attempts to recover a player if they ended up embedded in terrain.
 * Why: collision edge cases should never leave a player trapped inside the level.
 * @param {{state:any, p:any, nearby:any[]}} input
 */
function resolveEmbeddedPlayerInTerrain(input) {
  const maxPasses = 6;

  for (let pass = 0; pass < maxPasses; pass += 1) {
    const overlaps = input.nearby.filter((plat) => checkPlayerPlatformCollision({ player: input.p, platform: plat }));
    if (overlaps.length === 0) {
      return;
    }

    let resolvedThisPass = false;
    for (const plat of overlaps) {
      if (tryResolvePlayerOverlapWithPlatform({ state: input.state, p: input.p, platform: plat })) {
        clampToBounds({ p: input.p, hb: getPlayerHitbox(input.p), mapBounds: input.state.mapBounds });
        resolvedThisPass = true;
        break;
      }
    }

    if (!resolvedThisPass) {
      break;
    }
  }
}

/**
 * Tries to move a player to the nearest valid non-overlapping position relative to one platform.
 * @param {{state:any, p:any, platform:any}} input
 * @returns {boolean}
 */
function tryResolvePlayerOverlapWithPlatform(input) {
  const hb = getPlayerHitbox(input.p);
  const overlapLeft = hb.x + PLAYER_HITBOX_WIDTH - input.platform.x;
  const overlapRight = input.platform.x + input.platform.w - hb.x;
  const overlapTop = hb.y + PLAYER_HITBOX_HEIGHT - input.platform.y;
  const overlapBottom = input.platform.y + input.platform.h - hb.y;

  if (overlapLeft <= 0 || overlapRight <= 0 || overlapTop <= 0 || overlapBottom <= 0) {
    return false;
  }

  const candidates = [
    { axis: 'y', delta: -overlapTop, priority: 0 },
    { axis: 'x', delta: -overlapLeft, priority: 1 },
    { axis: 'x', delta: overlapRight, priority: 1 },
    { axis: 'y', delta: overlapBottom, priority: 2 },
  ];

  candidates.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return Math.abs(a.delta) - Math.abs(b.delta);
  });

  for (const candidate of candidates) {
    const nextX = candidate.axis === 'x' ? input.p.x + candidate.delta : input.p.x;
    const nextY = candidate.axis === 'y' ? input.p.y + candidate.delta : input.p.y;

    if (!isPlayerPlacementValid({ state: input.state, player: input.p, x: nextX, y: nextY })) {
      continue;
    }

    input.p.x = nextX;
    input.p.y = nextY;

    if (candidate.axis === 'x') {
      input.p.vx = 0;
    } else {
      input.p.vy = 0;
      if (candidate.delta < 0) {
        input.p.on_ground = true;
        input.p.jumps_remaining = 2;
      }
    }

    return true;
  }

  return tryNudgePlayerUpward({ state: input.state, p: input.p });
}

/**
 * Fallback recovery when a simple minimal translation is not enough.
 * @param {{state:any, p:any}} input
 * @returns {boolean}
 */
function tryNudgePlayerUpward(input) {
  for (let offset = 2; offset <= PLAYER_HITBOX_HEIGHT + 32; offset += 2) {
    const nextY = input.p.y - offset;
    if (!isPlayerPlacementValid({ state: input.state, player: input.p, x: input.p.x, y: nextY })) {
      continue;
    }

    input.p.y = nextY;
    input.p.vy = 0;
    input.p.on_ground = true;
    input.p.jumps_remaining = 2;
    return true;
  }

  return false;
}

/**
 * Checks AABB collision between player hitbox and platform.
 * @param {{player:any, platform:any}} input
 * @returns {boolean}
 */
function checkPlayerPlatformCollision(input) {
  const hb = getPlayerHitbox(input.player);

  return (
    hb.x < input.platform.x + input.platform.w &&
    hb.x + PLAYER_HITBOX_WIDTH > input.platform.x &&
    hb.y < input.platform.y + input.platform.h &&
    hb.y + PLAYER_HITBOX_HEIGHT > input.platform.y
  );
}

/**
 * Checks AABB collision for fireball/platform.
 * @param {{fireball:any, platform:any}} input
 * @returns {boolean}
 */
function checkFireballPlatformCollision(input) {
  const radius = FIREBALL_RADIUS * Math.max(0.2, Number(input.fireball.radius_scale) || 1);
  const closestX = Math.max(input.platform.x, Math.min(input.fireball.x, input.platform.x + input.platform.w));
  const closestY = Math.max(input.platform.y, Math.min(input.fireball.y, input.platform.y + input.platform.h));
  const dx = input.fireball.x - closestX;
  const dy = input.fireball.y - closestY;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * Checks fireball/player collision.
 * @param {{fireball:any, player:any}} input
 * @returns {boolean}
 */
function checkFireballPlayerCollision(input) {
  const radius = FIREBALL_RADIUS * Math.max(0.2, Number(input.fireball.radius_scale) || 1);
  const hb = getPlayerHitbox(input.player);
  const closestX = Math.max(hb.x, Math.min(input.fireball.x, hb.x + PLAYER_HITBOX_WIDTH));
  const closestY = Math.max(hb.y, Math.min(input.fireball.y, hb.y + PLAYER_HITBOX_HEIGHT));
  const dx = input.fireball.x - closestX;
  const dy = input.fireball.y - closestY;
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * Rounds to 1 decimal.
 * @param {number} n
 * @returns {number}
 */
function round1(n) {
  return Math.round(n * 10) / 10;
}

/**
 * Rounds to 3 decimals.
 * @param {number} n
 * @returns {number}
 */
function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * Stops the game loop interval.
 * Why: Conserve resources when no players are connected.
 * @returns {void}
 */
function stopGameLoop() {
  if (gameLoopInterval) {
    clearTimeout(gameLoopInterval);
    gameLoopInterval = null;
  }
}

/**
 * Restarts the game loop if it was stopped.
 * Why: Resume game physics when a player connects.
 * @returns {void}
 */
function restartGameLoop() {
  if (gameLoopInterval || !gameLoopContext) {
    return;
  }
  // Cleanup expired dead bodies before restarting loop
  cleanupDeadBodies({ state: gameLoopContext.state });
  startGameLoop(gameLoopContext);
}

module.exports = { startGameLoop, stopGameLoop, restartGameLoop };
