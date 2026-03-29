const { PLAYER_MAX_SIZE, PLAYER_MAX_HEALTH, ATTACK_DURATION, FIREBALL_POWER_MAX } = require('../state/constants');
const { pickSpawnPoint } = require('./spawn/pickSpawnPoint');
const { loadCharacters } = require('./characters/loadCharacters');

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
    player.inputs = data;
  });

  socket.on('jump', () => {
    const player = state.players.get(socket.id);
    if (!player || !player.is_ready) return;
    if (player.jumps_remaining > 0) {
      player.vy = -12 * 60;
      player.on_ground = false;
      player.jumps_remaining -= 1;
    }
  });

  socket.on('update_dimensions', (data) => {
    const player = state.players.get(socket.id);
    if (!player) return;
    player.render_width = typeof data?.width === 'number' ? data.width : PLAYER_MAX_SIZE;
    player.render_height = typeof data?.height === 'number' ? data.height : PLAYER_MAX_SIZE;
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

    const nowMs = Date.now();
    const now = nowMs / 1000;
    if (player.is_attacking && now - (player.attack_start_time ?? 0) < ATTACK_DURATION) {
      return;
    }

    player.is_attacking = true;
    player.attack_start_time = now;
    player.action = 'attack';

    const angle = typeof data?.angle === 'number' ? data.angle : 0;
    player.direction = Math.cos(angle) > 0 ? 'right' : 'left';

    const power = FIREBALL_POWER_MAX;
    const vx = Math.cos(angle) * power;
    const vy = Math.sin(angle) * power;

    const fireballId = state.nextFireballId;
    state.nextFireballId += 1;

    state.fireballs.set(fireballId, {
      id: fireballId,
      owner_sid: socket.id,
      x: player.x,
      y: player.y,
      vx,
      vy,
      start_x: player.x,
      start_y: player.y,
      initial_vx: vx,
      initial_vy: vy,
      distance_traveled: 0,
      spawn_time: now,
      spawn_time_ms: nowMs,
      active: true,
    });

    io.emit('projectile_created', {
      id: fireballId,
      owner_sid: socket.id,
      x: player.x,
      y: player.y,
      vx,
      vy,
      start_x: player.x,
      start_y: player.y,
      initial_vx: vx,
      initial_vy: vy,
      spawn_time_ms: nowMs,
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
  const playerName = String(nameQuery ?? `Player_${input.socket.id.slice(0, 4)}`).slice(0, 15);

  const characterInfo = loadCharacters({ state: input.state });
  const character = characterInfo.character;

  const spawnPoint = pickSpawnPoint({ state: input.state });

  input.state.players.set(input.socket.id, {
    name: playerName,
    x: spawnPoint.x,
    y: spawnPoint.y,
    vx: 0,
    vy: 0,
    on_ground: false,
    inputs: { left: false, right: false, up: false },
    action: 'idle',
    direction: 'right',
    frame: 0,
    render_width: PLAYER_MAX_SIZE,
    render_height: PLAYER_MAX_SIZE,
    is_ready: false,
    jumps_remaining: 2,
    character,
    health: PLAYER_MAX_HEALTH,
    is_dying: false,
    death_time: 0,
  });

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

  input.state.deadBodies.set(input.socket.id, deathData);
  input.io.emit('player_dying', deathData);
  input.state.players.delete(input.socket.id);
}

/**
 * Respawns a player to spawnPoints[0] with reset health.
 * @param {{socketId: string, state: any}} input
 */
function respawnPlayer(input) {
  const player = input.state.players.get(input.socketId);
  if (!player) return;

  const spawn = input.state.spawnPoints?.[0] ?? { x: 100, y: 500 };

  player.x = spawn.x;
  player.y = spawn.y;
  player.vx = 0;
  player.vy = 0;
  player.health = PLAYER_MAX_HEALTH;
  player.is_dying = false;
  player.death_time = 0;
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
  const { initializeFairies } = require('../state/fairies/fairySystem');

  const mapName = String(input.data?.name ?? 'default');
  const mapPath = path.join(input.state.dataDir, `${mapName}.json`);
  if (!fs.existsSync(mapPath)) {
    return;
  }

  const mapData = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

  const tiles = mapData.tiles;
  const mapWidth = mapData.width;
  const mapHeight = mapData.height;

  /** @type {Array<any>} */
  const platforms = [];
  for (let y = 0; y < mapHeight; y += 1) {
    for (let x = 0; x < mapWidth; x += 1) {
      const tileType = tiles?.[y]?.[x];
      if (typeof tileType === 'number' && tileType >= 0) {
        platforms.push({ x: x * TILE_SIZE, y: y * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE, tile_type: tileType });
      }
    }
  }

  input.state.platforms = platforms;
  input.state.platformGrid = buildPlatformGrid({ platforms });
  input.state.fairies = initializeFairies({ platforms });
  input.state.mapBounds = {
    min_x: 0,
    max_x: mapWidth * TILE_SIZE,
    min_y: 0,
    max_y: mapHeight * TILE_SIZE,
  };

  input.state.spawnPoints = Array.isArray(mapData.spawnPoints)
    ? mapData.spawnPoints
    : [{ x: 100, y: 500, id: 0 }];

  const player = input.state.players.get(input.socket.id);
  if (player && input.state.spawnPoints.length > 0) {
    player.x = input.state.spawnPoints[0].x;
    player.y = input.state.spawnPoints[0].y;
    player.vx = 0;
    player.vy = 0;
    player.on_ground = false;
  }

  input.io.emit('map_loaded', {
    name: mapName,
    width: mapWidth,
    height: mapHeight,
    tiles,
    spawnPoints: input.state.spawnPoints,
  });
}

module.exports = { registerSocketHandlers };
