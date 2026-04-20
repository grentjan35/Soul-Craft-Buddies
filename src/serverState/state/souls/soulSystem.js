const { getNearbyPlatforms } = require('../platformGrid/buildPlatformGrid');
const { TILE_SIZE, PLAYER_MAX_HEALTH } = require('../constants');
const {
  getPlayerRunStats,
  getSoulTierForCount,
  recordProgressionMetric,
} = require('../progression/system');
const { emitProgressionNotification } = require('../progression/notifications');

const SOUL_GRAVITY = 920;
const SOUL_FRICTION = 0.9;
const SOUL_BOUNCE = 0.18;
const SOUL_ATTRACT_RADIUS = 170;
const SOUL_COLLECT_RADIUS = 42;
const SOUL_ATTRACT_FORCE = 1080;
const SOUL_FLOAT_FORCE = 180;
const SOUL_MAX_SPEED = 340;
const SOUL_IDLE_LIFETIME_MS = 45000;
const SOUL_PLAYER_DROP_SPREAD_X = 18;
const SOUL_ENEMY_DROP_SPREAD_X = 14;
const SOUL_MAX_BUNDLE_VALUE = 5;
const SOUL_HEAL_PER_VALUE = 12;
const SOUL_RADIUS_BASE = 7;
const SOUL_PUBLIC_WARNING_TIER_INDEX = 2;

function formatPlayerName(player, fallbackId = 'player') {
  return String(player?.name ?? `P${String(fallbackId).slice(0, 4)}`);
}

function announceSoulTierRise(io, sid, player, previousSoulCount, nextSoulCount) {
  const previousTier = getSoulTierForCount(previousSoulCount);
  const nextTier = getSoulTierForCount(nextSoulCount);
  if (nextTier.index <= previousTier.index) {
    return;
  }

  emitProgressionNotification(io, sid, {
    type: nextTier.index >= SOUL_PUBLIC_WARNING_TIER_INDEX ? 'danger' : 'summon',
    title: nextTier.title,
    caption: 'Soul Dominion',
    message: `You now carry ${nextSoulCount} souls. Your flame is growing harder to challenge.`,
    xp: 0,
  });

  if (nextTier.index >= SOUL_PUBLIC_WARNING_TIER_INDEX) {
    io.emit('progression_notification', {
      type: 'danger',
      title: 'Soul Bounty Rising',
      caption: nextTier.title,
      message: `${formatPlayerName(player, sid)} is now carrying ${nextSoulCount} souls.`,
      xp: 0,
      timestamp: Date.now(),
    });
  }
}

function announceSoulTierFall(io, player, soulCount) {
  const tier = getSoulTierForCount(soulCount);
  if (tier.index < SOUL_PUBLIC_WARNING_TIER_INDEX) {
    return;
  }

  io.emit('progression_notification', {
    type: 'danger',
    title: 'Soul Hoard Shattered',
    caption: tier.title,
    message: `${formatPlayerName(player)} dropped ${soulCount} souls into the world.`,
    xp: 0,
    timestamp: Date.now(),
  });
}

function ensureSoulState(state) {
  if (!(state.souls instanceof Map)) {
    state.souls = new Map();
  }
  if (!Number.isFinite(state.nextSoulId)) {
    state.nextSoulId = 1;
  }
}

function spawnSoul(state, io, input) {
  ensureSoulState(state);

  const id = `soul_${state.nextSoulId++}`;
  const nowMs = Date.now();
  const soulValue = Math.max(1, Math.min(SOUL_MAX_BUNDLE_VALUE, Math.round(input.value || 1)));
  const soul = {
    id,
    x: Number(input.x) || 0,
    y: Number(input.y) || 0,
    vx: Number(input.vx) || 0,
    vy: Number(input.vy) || 0,
    phase: Number.isFinite(input.phase) ? input.phase : Math.random() * Math.PI * 2,
    size: Number.isFinite(input.size) ? input.size : (0.58 + Math.random() * 0.24) * (0.96 + Math.sqrt(soulValue) * 0.22),
    tint: Number.isFinite(input.tint) ? input.tint : Math.random(),
    value: soulValue,
    spawn_time_ms: nowMs,
  };

  state.souls.set(id, soul);
  if (io) {
    io.emit('soul_spawned', serializeSoul(soul));
  }
  return soul;
}

function getSoulRadius(soul) {
  const soulValue = Math.max(1, Math.round(soul?.value || 1));
  const size = Number.isFinite(soul?.size) ? soul.size : 1;
  return SOUL_RADIUS_BASE * size * (1 + Math.max(0, soulValue - 1) * 0.08);
}

function spawnSoulsBurst(state, io, input) {
  const count = Math.max(0, Math.round(input.count || 0));
  const spreadX = Number.isFinite(input.spreadX) ? input.spreadX : 16;
  const baseLift = Number.isFinite(input.baseLift) ? input.baseLift : 150;
  const burstSoulValues = buildBurstSoulValues(count);

  for (let i = 0; i < burstSoulValues.length; i += 1) {
    const soulValue = burstSoulValues[i];
    const angle = (-0.7 + (count <= 1 ? 0.5 : i / Math.max(1, count - 1)) * 1.4) + (Math.random() - 0.5) * 0.2;
    const speed = 42 + Math.random() * 62;
    spawnSoul(state, io, {
      x: (Number(input.x) || 0) + (Math.random() - 0.5) * spreadX,
      y: (Number(input.y) || 0) - 6 - Math.random() * 10,
      vx: Math.cos(angle) * speed + (Math.random() - 0.5) * 24,
      vy: -baseLift - Math.random() * 90,
      value: soulValue,
    });
  }
}

function dropSoulsForPlayerDeath(state, io, player) {
  const carriedSoulCount = Math.max(0, Math.round(player.soul_count || 0));
  const soulCount = Math.max(1, carriedSoulCount);
  spawnSoulsBurst(state, io, {
    x: player.x,
    y: player.y - 10,
    count: soulCount,
    spreadX: SOUL_PLAYER_DROP_SPREAD_X,
    baseLift: 165,
  });
  if (carriedSoulCount > 0 && io) {
    announceSoulTierFall(io, player, carriedSoulCount);
  }
  player.soul_count = 0;
}

function dropSoulsForEnemyDeath(state, io, enemy) {
  const count = 1 + Math.floor(Math.random() * 3);
  spawnSoulsBurst(state, io, {
    x: enemy.x,
    y: enemy.y - 8,
    count,
    spreadX: SOUL_ENEMY_DROP_SPREAD_X,
    baseLift: 125,
  });
}

function clampSoulToBounds(state, soul) {
  if (!state.mapBounds) {
    return;
  }

  const radius = getSoulRadius(soul);
  const prevY = soul.y;
  soul.x = Math.max(state.mapBounds.min_x + radius, Math.min(state.mapBounds.max_x - radius, soul.x));
  soul.y = Math.max(state.mapBounds.min_y + radius, Math.min(state.mapBounds.max_y - radius, soul.y));

  if (prevY < state.mapBounds.max_y - radius && soul.y >= state.mapBounds.max_y - radius) {
    soul.y = state.mapBounds.max_y - radius;
    soul.vy = -Math.abs(soul.vy) * SOUL_BOUNCE;
    soul.vx *= 0.86;
    if (Math.abs(soul.vy) < 18) {
      soul.vy = 0;
    }
  }
}

function resolveSoulPlatformCollisions(state, soul, prevY) {
  const radius = getSoulRadius(soul);
  const nearby = getNearbyPlatforms({
    platformGrid: state.platformGrid,
    x: soul.x,
    y: soul.y,
  });

  for (const platform of nearby) {
    const withinHorizontal = soul.x >= platform.x - radius && soul.x <= platform.x + platform.w + radius;
    const platformTop = platform.y - radius;
    const crossedTop = prevY <= platformTop && soul.y >= platformTop;
    if (!withinHorizontal || !crossedTop) {
      continue;
    }

    soul.y = platformTop;
    soul.vy = soul.vy < 0 ? soul.vy : -Math.abs(soul.vy) * SOUL_BOUNCE;
    soul.vx *= 0.86;
    if (Math.abs(soul.vy) < 18) {
      soul.vy = 0;
    }
    return;
  }
}


function buildBurstSoulValues(totalCount) {
  const values = [];
  let remaining = Math.max(0, Math.round(totalCount || 0));

  while (remaining > 0) {
    if (remaining >= 3 && Math.random() < 0.34) {
      const maxBundle = Math.min(SOUL_MAX_BUNDLE_VALUE, remaining);
      const bundleValue = Math.max(3, Math.floor(3 + Math.random() * (maxBundle - 2)));
      values.push(bundleValue);
      remaining -= bundleValue;
      continue;
    }

    values.push(1);
    remaining -= 1;
  }

  return values;
}

function findGroundY(state, x, y, radius) {
  let bestY = state.mapBounds ? state.mapBounds.max_y - radius : y;
  const nearby = getNearbyPlatforms({
    platformGrid: state.platformGrid,
    x,
    y: y + TILE_SIZE * 2,
  });

  for (const platform of nearby) {
    const withinHorizontal = x >= platform.x - radius && x <= platform.x + platform.w + radius;
    const platformTop = platform.y - radius;
    if (!withinHorizontal || platformTop < y - radius) {
      continue;
    }
    if (platformTop < bestY) {
      bestY = platformTop;
    }
  }

  return bestY;
}
function serializeSoul(soul) {
  return {
    id: soul.id,
    x: Math.round(soul.x * 10) / 10,
    y: Math.round(soul.y * 10) / 10,
    vx: Math.round(soul.vx * 10) / 10,
    vy: Math.round(soul.vy * 10) / 10,
    size: Math.round((soul.size ?? 1) * 100) / 100,
    tint: Math.round((soul.tint ?? 0) * 1000) / 1000,
    value: Math.max(1, Math.round(soul.value || 1)),
    spawn_time_ms: soul.spawn_time_ms,
  };
}

function serializeSoulsForState(state) {
  ensureSoulState(state);
  const payload = {};
  for (const soul of state.souls.values()) {
    payload[soul.id] = serializeSoul(soul);
  }
  return payload;
}

function updateSouls(input) {
  ensureSoulState(input.state);
  const nowMs = Date.now();
  const removals = [];

  for (const soul of input.state.souls.values()) {
    if (nowMs - soul.spawn_time_ms > SOUL_IDLE_LIFETIME_MS) {
      removals.push(soul.id);
      continue;
    }

    const prevY = soul.y;
    soul.phase += input.dt * 2.4;
    soul.vy += SOUL_GRAVITY * input.dt;
    soul.vx *= Math.pow(SOUL_FRICTION, input.dt * 60);

    let nearestSid = null;
    let nearestPlayer = null;
    let nearestDistance = Number.POSITIVE_INFINITY;

    for (const [sid, player] of input.state.players.entries()) {
      if (!player || player.is_dying) {
        continue;
      }
      const dx = player.x - soul.x;
      const dy = (player.y - 18) - soul.y;
      const distance = Math.hypot(dx, dy);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestSid = sid;
        nearestPlayer = player;
      }
    }

    const nearestStats = nearestPlayer ? getPlayerRunStats(nearestPlayer) : null;
    const magnetMultiplier = nearestStats ? Math.max(0.6, Number(nearestStats.soulMagnetMultiplier) || 1) : 1;
    const healMultiplier = nearestStats ? Math.max(0.5, Number(nearestStats.soulHealMultiplier) || 1) : 1;
    const attractRadius = SOUL_ATTRACT_RADIUS * magnetMultiplier;

    if (nearestPlayer && nearestDistance <= attractRadius) {
      const dx = nearestPlayer.x - soul.x;
      const dy = (nearestPlayer.y - 20) - soul.y;
      const invDistance = 1 / Math.max(10, nearestDistance);
      const closeness = 1 - nearestDistance / attractRadius;
      soul.vx += dx * invDistance * SOUL_ATTRACT_FORCE * closeness * input.dt;
      soul.vy += dy * invDistance * SOUL_ATTRACT_FORCE * closeness * input.dt;
      soul.vy += Math.sin(soul.phase * 2.2) * SOUL_FLOAT_FORCE * input.dt;

      if (closeness > 0.65) {
        soul.vx += dx * invDistance * SOUL_ATTRACT_FORCE * 0.42 * input.dt;
        soul.vy += dy * invDistance * SOUL_ATTRACT_FORCE * 0.58 * input.dt;
      }

      const soulValue = Math.max(1, Math.round(soul.value || 1));
      const collectRadius = (SOUL_COLLECT_RADIUS + Math.max(0, soulValue - 1) * 8 + Math.max(0, (soul.size || 1) - 1) * 8) * Math.min(1.65, magnetMultiplier);
      if (nearestDistance <= collectRadius) {
        const previousSoulCount = Math.max(0, Math.round(nearestPlayer.soul_count || 0));
        const previousMaxHealth = Math.max(1, Number(nearestStats?.maxHealth) || PLAYER_MAX_HEALTH);
        const wasEffectivelyFullHealth = Number.isFinite(nearestPlayer.health) && nearestPlayer.health >= previousMaxHealth - 0.01;
        nearestPlayer.soul_count = previousSoulCount + soulValue;
        const unlockedAchievements = recordProgressionMetric(nearestPlayer, 'soulsCollected', soulValue);
        if (Number.isFinite(nearestPlayer.health)) {
          const refreshedStats = getPlayerRunStats(nearestPlayer);
          const maxHealth = Math.max(1, Number(refreshedStats?.maxHealth) || PLAYER_MAX_HEALTH);
          nearestPlayer.health = wasEffectivelyFullHealth
            ? maxHealth
            : Math.min(maxHealth, nearestPlayer.health + soulValue * SOUL_HEAL_PER_VALUE * healMultiplier);
        }
        for (const achievement of unlockedAchievements) {
          emitProgressionNotification(input.io, nearestSid, achievement);
        }
        announceSoulTierRise(input.io, nearestSid, nearestPlayer, previousSoulCount, nearestPlayer.soul_count);
        removals.push(soul.id);
        input.io.emit('soul_collected', {
          soul: serializeSoul(soul),
          target_sid: nearestSid,
          target_x: Math.round(nearestPlayer.x * 10) / 10,
          target_y: Math.round(nearestPlayer.y * 10) / 10,
          soul_count: nearestPlayer.soul_count,
          health: nearestPlayer.health,
          collected_at_ms: nowMs,
        });
        continue;
      }
    } else {
      soul.vy += Math.sin(soul.phase) * SOUL_FLOAT_FORCE * 0.18 * input.dt;
    }

    const speed = Math.hypot(soul.vx, soul.vy);
    if (speed > SOUL_MAX_SPEED) {
      const scale = SOUL_MAX_SPEED / speed;
      soul.vx *= scale;
      soul.vy *= scale;
    }

    soul.x += soul.vx * input.dt;
    soul.y += soul.vy * input.dt;
    clampSoulToBounds(input.state, soul);
    resolveSoulPlatformCollisions(input.state, soul, prevY);

    const radius = getSoulRadius(soul);
    const floorY = findGroundY(input.state, soul.x, prevY, radius);
    if (soul.y > floorY) {
      soul.y = floorY;
      if (soul.vy > 0) {
        soul.vy = -Math.abs(soul.vy) * SOUL_BOUNCE;
        if (Math.abs(soul.vy) < 18) {
          soul.vy = 0;
        }
      }
    }
  }

  for (const soulId of removals) {
    if (input.state.souls.delete(soulId)) {
      input.io.emit('soul_removed', { id: soulId });
    }
  }
}

module.exports = {
  dropSoulsForEnemyDeath,
  dropSoulsForPlayerDeath,
  ensureSoulState,
  serializeSoulsForState,
  spawnSoul,
  spawnSoulsBurst,
  updateSouls,
};
