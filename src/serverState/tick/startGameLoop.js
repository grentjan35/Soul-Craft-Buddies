const {
  FRAME_TIME,
  FIREBALL_SIZE,
  FIREBALL_DAMAGE,
  FIREBALL_LIFETIME,
  FIREBALL_MAX_DISTANCE,
  EXPLOSION_DURATION,
  ATTACK_DURATION,
  GRAVITY,
  MOVE_SPEED,
  PLAYER_HITBOX_WIDTH,
  PLAYER_HITBOX_HEIGHT,
  PLAYER_MAX_HEALTH,
} = require('../state/constants');
const { getNearbyPlatforms } = require('../state/platformGrid/buildPlatformGrid');
const { updateFairies } = require('../state/fairies/fairySystem');

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

    const spawn = input.state.spawnPoints?.[0] ?? { x: 100, y: 500 };
    p.x = spawn.x;
    p.y = spawn.y;
    p.vx = 0;
    p.vy = 0;
    p.health = PLAYER_MAX_HEALTH;
    p.is_dying = false;
    p.death_time = 0;

    input.io.emit('player_respawned', { sid });
  }
}
function startGameLoop(input) {
  let lastTimeMs = Date.now();
  let lastBroadcastMs = Date.now();
  const broadcastIntervalMs = 1000 / 20;

  setInterval(() => {
    const nowMs = Date.now();
    let dt = (nowMs - lastTimeMs) / 1000;
    lastTimeMs = nowMs;

    dt = Math.min(dt, 0.1);

    updateGameState({ state: input.state, dt });
    updateFairies({ fairies: input.state.fairies, dt });
    updateFireballs({ state: input.state, dt, io: input.io });
    updateExplosions({ state: input.state, io: input.io });
    updateDeathsAndRespawns({ state: input.state, io: input.io });
    cleanupDeadBodies({ state: input.state });

    if (nowMs - lastBroadcastMs >= broadcastIntervalMs) {
      lastBroadcastMs = nowMs;
      broadcastState({ io: input.io, state: input.state });
    }
  }, FRAME_TIME * 1000);
}

/**
 * Broadcasts current state.
 * @param {{io: import('socket.io').Server, state: any}} input
 */
function broadcastState(input) {
  input.state.stateSeq += 1;
  const ts = Date.now();

  /** @type {Record<string, any>} */
  const playersPayload = {};
  for (const [sid, p] of input.state.players.entries()) {
    if (p.is_dying) continue;
    playersPayload[sid] = {
      name: p.name,
      x: round1(p.x),
      y: round1(p.y),
      vy: round1(p.vy),
      action: p.action,
      direction: p.direction,
      on_ground: p.on_ground,
      render_width: p.render_width,
      render_height: p.render_height,
      character: p.character,
      health: p.health,
    };
  }

  /** @type {Record<string, any>} */
  const fireballsPayload = {};
  for (const [id, f] of input.state.fireballs.entries()) {
    if (!f.active) continue;
    fireballsPayload[id] = {
      owner_sid: f.owner_sid,
      x: round1(f.x),
      y: round1(f.y),
      vx: round1(f.vx),
      vy: round1(f.vy),
      start_x: round1(f.start_x),
      start_y: round1(f.start_y),
      initial_vx: round1(f.initial_vx ?? f.vx),
      initial_vy: round1(f.initial_vy ?? f.vy),
      spawn_time_ms: f.spawn_time_ms ?? Math.round((f.spawn_time ?? 0) * 1000),
    };
  }

  /** @type {Record<string, any>} */
  const explosionsPayload = {};
  const nowSec = Date.now() / 1000;
  for (const [id, e] of input.state.explosions.entries()) {
    if (!e.active) continue;
    explosionsPayload[id] = {
      x: e.x,
      y: e.y,
      age: round3(nowSec - e.spawn_time),
    };
  }

  input.io.emit('state', {
    ts,
    seq: input.state.stateSeq,
    players: playersPayload,
    fairies: input.state.fairies,
    fireballs: fireballsPayload,
    explosions: explosionsPayload,
  });
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

    p.vx = 0;

    const canMove = !(p.is_attacking && p.on_ground);

    if (canMove) {
      if (p.inputs?.left) {
        p.vx -= MOVE_SPEED;
        if (!p.is_attacking) p.direction = 'left';
      }
      if (p.inputs?.right) {
        p.vx += MOVE_SPEED;
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

    if (p.is_attacking) {
      const attackStart = p.attack_start_time ?? 0;
      if (nowSec - attackStart >= ATTACK_DURATION) {
        p.is_attacking = false;
      } else {
        p.action = 'attack';
      }
    }

    if (!p.is_attacking) {
      if (!p.on_ground) p.action = 'jump';
      else if (Math.abs(p.vx) > 0) p.action = 'run';
      else p.action = 'idle';
    }

    p.frame = (Number(p.frame ?? 0) + 1) % 60;

    // Input: [1], Loop index starts at 0 (single player): dying check above prevents updates.
    void prevX;
    void prevY;
    void sid;
  }

  resolvePlayerPlayerCollisions({ state: input.state });
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
  /** @type {number[]} */
  const toRemove = [];

  for (const [id, f] of input.state.fireballs.entries()) {
    if (!f.active) continue;

    f.vy += GRAVITY * input.dt * 60;
    f.x += f.vx * input.dt;
    f.y += f.vy * input.dt;

    const dx = f.x - f.start_x;
    const dy = f.y - f.start_y;
    f.distance_traveled = Math.sqrt(dx * dx + dy * dy);

    const age = nowSec - f.spawn_time;
    if (age > FIREBALL_LIFETIME || f.distance_traveled > FIREBALL_MAX_DISTANCE) {
      toRemove.push(id);
      createExplosion({ state: input.state, io: input.io, x: f.x, y: f.y });
      continue;
    }

    const nearby = getNearbyPlatforms({
      platformGrid: input.state.platformGrid,
      x: f.x,
      y: f.y,
    });

    if (nearby.some((plat) => checkFireballPlatformCollision({ fireball: f, platform: plat }))) {
      toRemove.push(id);
      createExplosion({ state: input.state, io: input.io, x: f.x, y: f.y });
      continue;
    }

    for (const [sid, p] of input.state.players.entries()) {
      if (p.is_dying) continue;
      if (sid === f.owner_sid) continue;

      if (checkFireballPlayerCollision({ fireball: f, player: p })) {
        p.health -= FIREBALL_DAMAGE;
        if (p.health <= 0) {
          p.health = 0;
          p.is_dying = true;
          p.death_time = nowSec;
          input.io.emit('player_dying', {
            sid,
            x: p.x,
            y: p.y,
            vy: p.vy,
            on_ground: p.on_ground,
            character: p.character,
            direction: p.direction,
            timestamp: nowSec,
          });
        }

        createExplosion({ state: input.state, io: input.io, x: f.x, y: f.y });
        input.io.emit('player_hit', {
          sid,
          damage: FIREBALL_DAMAGE,
          health: p.health,
          is_dying: p.is_dying,
        });

        toRemove.push(id);
        break;
      }
    }
  }

  for (const id of toRemove) {
    if (input.state.fireballs.has(id)) {
      const fireball = input.state.fireballs.get(id);
      input.state.fireballs.delete(id);
      input.io.emit('projectile_destroyed', {
        id,
        destroy_time_ms: Date.now(),
        x: fireball?.x,
        y: fireball?.y,
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
      input.state.explosions.delete(id);
      input.io.emit('explosion_destroyed', { id, destroy_time_ms: nowMs });
    }
  }
}

/**
 * Creates an explosion.
 * @param {{state: any, io: import('socket.io').Server, x: number, y: number}} input
 */
function createExplosion(input) {
  const nowMs = Date.now();
  const id = `${nowMs}_${Math.random().toString(16).slice(2)}`;
  const nowSec = nowMs / 1000;

  input.state.explosions.set(id, { id, x: input.x, y: input.y, spawn_time: nowSec, spawn_time_ms: nowMs, active: true });
  input.io.emit('explosion_created', { id, x: input.x, y: input.y, spawn_time_ms: nowMs });
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
  const prevHbY = input.prevY - halfH;

  for (const plat of input.nearby) {
    if (!checkPlayerPlatformCollision({ player: input.p, platform: plat })) continue;

    const wasOutside =
      prevHbY + PLAYER_HITBOX_HEIGHT <= plat.y || prevHbY >= plat.y + plat.h;

    if (!wasOutside) continue;

    if (input.p.vy > 0) {
      input.p.y = plat.y - halfH;
      input.p.vy = 0;
      input.p.on_ground = true;
      input.p.jumps_remaining = 2;
    } else if (input.p.vy < 0) {
      input.p.y = plat.y + plat.h + halfH;
      input.p.vy = 0;
    }
  }
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
  const half = FIREBALL_SIZE / 2;
  const x = input.fireball.x - half;
  const y = input.fireball.y - half;

  return (
    x < input.platform.x + input.platform.w &&
    x + FIREBALL_SIZE > input.platform.x &&
    y < input.platform.y + input.platform.h &&
    y + FIREBALL_SIZE > input.platform.y
  );
}

/**
 * Checks fireball/player collision.
 * @param {{fireball:any, player:any}} input
 * @returns {boolean}
 */
function checkFireballPlayerCollision(input) {
  const half = FIREBALL_SIZE / 2;
  const fx = input.fireball.x - half;
  const fy = input.fireball.y - half;
  const hb = getPlayerHitbox(input.player);

  return (
    fx < hb.x + PLAYER_HITBOX_WIDTH &&
    fx + FIREBALL_SIZE > hb.x &&
    fy < hb.y + PLAYER_HITBOX_HEIGHT &&
    fy + FIREBALL_SIZE > hb.y
  );
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

module.exports = { startGameLoop };
