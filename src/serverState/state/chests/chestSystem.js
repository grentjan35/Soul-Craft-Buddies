const {
  awardChestCard,
  gainPlayerXp,
  isPlayerDrafting,
  recordProgressionMetric,
} = require('../progression/system');
const { emitProgressionNotification } = require('../progression/notifications');

const CHEST_SPAWN_INTERVAL_MS = 30_000;
const CHEST_ALERT_DURATION_MS = 10_000;
const CHEST_ARM_DELAY_MS = 10_000;
const CHEST_INTERACT_RADIUS = 92;
const CHEST_POST_OPEN_HOLD_MS = 720;
const CHEST_DESPAWN_DURATION_MS = 1_500;
const CHEST_IDLE_LIFETIME_MS = 120_000;
const CHEST_MAX_ACTIVE = 6;
const CHEST_MIN_SPACING = 150;
const CHEST_PLATFORM_CLEARANCE = 46;
const CHEST_HITBOX_WIDTH = 54;
const CHEST_HITBOX_HEIGHT = 54;

const CHEST_RARITY_CONFIG = Object.freeze({
  normal: {
    label: 'Normal',
    weight: 90,
    openDurationMs: 5_000,
    landingDurationMs: 1_250,
    xpMin: 16,
    xpMax: 34,
    soulMin: 10,
    soulMax: 16,
    cardChance: 0.12,
    cardRarities: ['common', 'uncommon'],
    cardRarityBias: {
      common: 1,
      uncommon: 1.2,
    },
    cardLevelBoost: 2,
  },
  rare: {
    label: 'Rare',
    weight: 9,
    openDurationMs: 6_000,
    landingDurationMs: 1_500,
    xpMin: 42,
    xpMax: 72,
    soulMin: 18,
    soulMax: 30,
    cardChance: 1,
    cardRarities: ['rare', 'epic', 'legendary'],
    cardRarityBias: {
      rare: 10,
      epic: 5.2,
      legendary: 0.45,
    },
    cardLevelBoost: 7,
  },
  mythic: {
    label: 'Mythic',
    weight: 1,
    openDurationMs: 10_000,
    landingDurationMs: 1_850,
    xpMin: 110,
    xpMax: 180,
    soulMin: 30,
    soulMax: 56,
    cardChance: 1,
    cardRarities: ['rare', 'epic', 'legendary'],
    cardRarityBias: {
      rare: 2.4,
      epic: 6.4,
      legendary: 1.8,
    },
    cardLevelBoost: 14,
  },
});

function ensureChestState(state) {
  if (!(state.chests instanceof Map)) {
    state.chests = new Map();
  }
  if (!Number.isFinite(state.nextChestId)) {
    state.nextChestId = 1;
  }
  if (!Number.isFinite(state.nextChestSpawnAtMs)) {
    state.nextChestSpawnAtMs = Date.now() + CHEST_SPAWN_INTERVAL_MS;
  }
}

function resetChestStateForMap(state) {
  ensureChestState(state);
  state.chests.clear();
  state.nextChestSpawnAtMs = Date.now() + CHEST_SPAWN_INTERVAL_MS;
}

function serializeChestsForState(state) {
  ensureChestState(state);
  /** @type {Record<string, any>} */
  const payload = {};

  for (const [id, chest] of state.chests.entries()) {
    payload[id] = {
      id,
      rarity: chest.rarity,
      x: round1(chest.x),
      y: round1(chest.y),
      spawn_from_y: round1(chest.spawn_from_y),
      spawn_time_ms: chest.spawn_time_ms,
      landing_duration_ms: chest.landing_duration_ms,
      alert_duration_ms: CHEST_ALERT_DURATION_MS,
      available_at_ms: chest.available_at_ms || 0,
      interact_radius: CHEST_INTERACT_RADIUS,
      open_duration_ms: chest.open_duration_ms,
      opening_started_at_ms: chest.opening_started_at_ms || 0,
      opener_sid: chest.opener_sid || null,
      opened_at_ms: chest.opened_at_ms || 0,
      claimed_by_sid: chest.claimed_by_sid || null,
      despawn_started_at_ms: chest.despawn_started_at_ms || 0,
      despawn_duration_ms: CHEST_DESPAWN_DURATION_MS,
      expires_at_ms: chest.expires_at_ms || 0,
    };
  }

  return payload;
}

function updateChests(input) {
  const { state, io } = input;
  ensureChestState(state);
  const nowMs = Date.now();

  maybeSpawnChest({ state, io, nowMs });

  /** @type {string[]} */
  const toDelete = [];
  for (const [chestId, chest] of state.chests.entries()) {
    if (!chest) {
      toDelete.push(chestId);
      continue;
    }

    if (!chest.opened_at_ms && !chest.despawn_started_at_ms && !chest.opener_sid && nowMs >= (chest.expires_at_ms || 0)) {
      chest.despawn_started_at_ms = nowMs;
    }

    if (!chest.opened_at_ms && chest.opener_sid) {
      const opener = state.players.get(chest.opener_sid);
      if (!canPlayerOpenChest(opener, chest)) {
        cancelChestOpening(chest);
      } else if (nowMs >= (chest.opening_started_at_ms || 0) + chest.open_duration_ms) {
        openChest({ state, io, chest, openerSid: chest.opener_sid, opener, nowMs });
      }
    }

    if (chest.opened_at_ms && !chest.despawn_started_at_ms && nowMs >= chest.opened_at_ms + CHEST_POST_OPEN_HOLD_MS) {
      chest.despawn_started_at_ms = nowMs;
    }

    if (chest.despawn_started_at_ms && nowMs >= chest.despawn_started_at_ms + CHEST_DESPAWN_DURATION_MS) {
      toDelete.push(chestId);
    }
  }

  for (const chestId of toDelete) {
    state.chests.delete(chestId);
  }
}

function handleChestInteractRequest(input) {
  const { state, io, socketId, chestId } = input;
  ensureChestState(state);
  const nowMs = Date.now();

  const player = state.players.get(socketId);
  if (!player || !player.is_ready || player.is_dying || isPlayerDrafting(player)) {
    return;
  }

  const chest = state.chests.get(chestId);
  if (!chest || chest.opened_at_ms || chest.despawn_started_at_ms) {
    return;
  }
  if (!canPlayerOpenChest(player, chest, nowMs)) {
    if (nowMs < (Number(chest.available_at_ms) || 0)) {
      const remainingMs = Math.max(0, Number(chest.available_at_ms) - nowMs);
      io.to(socketId).emit('progression_notification', {
        type: 'chest',
        title: `${CHEST_RARITY_CONFIG[chest.rarity]?.label || 'Chest'} Chest`,
        message: `The chest is stabilizing. Wait ${remainingMs >= 1000 ? (remainingMs / 1000).toFixed(1) : 'a moment'} more seconds.`,
        xp: 0,
        caption: 'Power building',
      });
    }
    return;
  }

  for (const otherChest of state.chests.values()) {
    if (otherChest?.opener_sid === socketId && otherChest.id !== chest.id && !otherChest.opened_at_ms) {
      cancelChestOpening(otherChest);
    }
  }

  if (chest.opener_sid && chest.opener_sid !== socketId) {
    return;
  }
  if (chest.opener_sid === socketId && chest.opening_started_at_ms) {
    return;
  }

  chest.opener_sid = socketId;
  chest.opening_started_at_ms = nowMs;

  io.to(socketId).emit('progression_notification', {
    type: 'chest',
    title: `${CHEST_RARITY_CONFIG[chest.rarity]?.label || 'Chest'} Chest`,
    message: `Opening... stay close for ${Math.round(chest.open_duration_ms / 1000)} seconds.`,
    xp: 0,
    caption: 'Hold your ground',
  });
}

function clearChestInteractionForPlayer(state, socketId) {
  ensureChestState(state);
  for (const chest of state.chests.values()) {
    if (chest?.opener_sid === socketId && !chest.opened_at_ms) {
      cancelChestOpening(chest);
    }
  }
}

function maybeSpawnChest(input) {
  const { state, io, nowMs } = input;
  if (nowMs < state.nextChestSpawnAtMs) {
    return;
  }

  state.nextChestSpawnAtMs = nowMs + CHEST_SPAWN_INTERVAL_MS;
  if (state.chests.size >= CHEST_MAX_ACTIVE) {
    return;
  }

  const spawnPoint = pickChestSpawnPoint(state);
  if (!spawnPoint) {
    return;
  }

  const rarity = rollChestRarity();
  const config = CHEST_RARITY_CONFIG[rarity];
  const spawnFromY = spawnPoint.y - randomInt(220, rarity === 'mythic' ? 520 : 420);
  const chestId = `chest_${state.nextChestId}`;
  state.nextChestId += 1;

  state.chests.set(chestId, {
    id: chestId,
    rarity,
    x: spawnPoint.x,
    y: spawnPoint.y,
    spawn_from_y: spawnFromY,
    spawn_time_ms: nowMs,
    landing_duration_ms: config.landingDurationMs,
    open_duration_ms: config.openDurationMs,
    available_at_ms: nowMs + CHEST_ARM_DELAY_MS,
    opening_started_at_ms: 0,
    opener_sid: null,
    opened_at_ms: 0,
    claimed_by_sid: null,
    despawn_started_at_ms: 0,
    expires_at_ms: nowMs + CHEST_IDLE_LIFETIME_MS,
  });

  io.emit('chest_spawned', {
    id: chestId,
    rarity,
    x: round1(spawnPoint.x),
    y: round1(spawnPoint.y),
    spawn_from_y: round1(spawnFromY),
    spawn_time_ms: nowMs,
    landing_duration_ms: config.landingDurationMs,
    alert_duration_ms: CHEST_ALERT_DURATION_MS,
    available_at_ms: nowMs + CHEST_ARM_DELAY_MS,
  });
}

function pickChestSpawnPoint(state) {
  const platforms = Array.isArray(state.platforms)
    ? state.platforms.filter((platform) => platform && Number(platform.w) >= 72 && Number(platform.h) >= 8)
    : [];
  const candidates = platforms.length > 0
    ? platforms
    : [{
        x: Number(state.mapBounds?.min_x) || 0,
        y: Math.max(32, (Number(state.mapBounds?.max_y) || 600) - 36),
        w: Math.max(120, (Number(state.mapBounds?.max_x) || 1200) - (Number(state.mapBounds?.min_x) || 0)),
        h: 12,
      }];

  for (let attempt = 0; attempt < 32; attempt += 1) {
    const platform = candidates[Math.floor(Math.random() * candidates.length)];
    if (!platform) {
      continue;
    }

    const margin = Math.min(28, Math.max(12, Number(platform.w) * 0.14));
    const usableWidth = Math.max(1, Number(platform.w) - margin * 2);
    const x = Number(platform.x) + margin + Math.random() * usableWidth;
    const y = Number(platform.y);
    const chestHitbox = getChestHitboxAt(x, y);

    let overlapsExisting = false;
    for (const chest of state.chests.values()) {
      if (!chest) {
        continue;
      }
      if (Math.hypot(chest.x - x, chest.y - y) < CHEST_MIN_SPACING) {
        overlapsExisting = true;
        break;
      }
    }

    if (!overlapsExisting && isChestHitboxClear(state, platform, chestHitbox)) {
      return { x, y };
    }
  }

  return null;
}

function canPlayerOpenChest(player, chest, nowMs = Date.now()) {
  if (!player || player.is_dying || isPlayerDrafting(player)) {
    return false;
  }

  if (nowMs < (Number(chest?.available_at_ms) || 0)) {
    return false;
  }

  return Number.isFinite(player.x)
    && Number.isFinite(player.y)
    && Math.hypot(player.x - chest.x, player.y - chest.y) <= CHEST_INTERACT_RADIUS;
}

function getChestHitboxAt(x, groundY) {
  return {
    x: Number(x) - CHEST_HITBOX_WIDTH / 2,
    y: Number(groundY) - CHEST_HITBOX_HEIGHT - CHEST_PLATFORM_CLEARANCE,
    w: CHEST_HITBOX_WIDTH,
    h: CHEST_HITBOX_HEIGHT,
  };
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.w
    && a.x + a.w > b.x
    && a.y < b.y + b.h
    && a.y + a.h > b.y;
}

function isChestHitboxClear(state, supportPlatform, chestHitbox) {
  if (!chestHitbox || !Number.isFinite(chestHitbox.x) || !Number.isFinite(chestHitbox.y)) {
    return false;
  }

  const mapMinX = Number(state.mapBounds?.min_x);
  const mapMaxX = Number(state.mapBounds?.max_x);
  const mapMinY = Number(state.mapBounds?.min_y);
  const mapMaxY = Number(state.mapBounds?.max_y);
  if (Number.isFinite(mapMinX) && chestHitbox.x < mapMinX) {
    return false;
  }
  if (Number.isFinite(mapMaxX) && chestHitbox.x + chestHitbox.w > mapMaxX) {
    return false;
  }
  if (Number.isFinite(mapMinY) && chestHitbox.y < mapMinY) {
    return false;
  }
  if (Number.isFinite(mapMaxY) && chestHitbox.y + chestHitbox.h > mapMaxY) {
    return false;
  }

  const platforms = Array.isArray(state.platforms) ? state.platforms : [];
  for (const platform of platforms) {
    if (!platform || !Number.isFinite(platform.x) || !Number.isFinite(platform.y) || !Number.isFinite(platform.w) || !Number.isFinite(platform.h)) {
      continue;
    }

    if (platform === supportPlatform) {
      continue;
    }

    if (rectsOverlap(chestHitbox, platform)) {
      return false;
    }
  }

  return true;
}

function cancelChestOpening(chest) {
  chest.opener_sid = null;
  chest.opening_started_at_ms = 0;
}

function openChest(input) {
  const { state, io, chest, openerSid, opener, nowMs } = input;
  const rarityConfig = CHEST_RARITY_CONFIG[chest.rarity] || CHEST_RARITY_CONFIG.normal;
  const rewardXp = randomInt(rarityConfig.xpMin, rarityConfig.xpMax);
  const rewardSouls = randomInt(rarityConfig.soulMin, rarityConfig.soulMax);
  const xpResult = gainPlayerXp(opener, rewardXp);

  const previousSoulCount = Math.max(0, Math.round(Number(opener.soul_count) || 0));
  opener.soul_count = previousSoulCount + rewardSouls;
  const unlockedAchievements = recordProgressionMetric(opener, 'soulsCollected', rewardSouls);
  const cardReward = Math.random() <= rarityConfig.cardChance
    ? awardChestCard(opener, {
        allowedRarities: rarityConfig.cardRarities,
        rarityWeightMultipliers: rarityConfig.cardRarityBias,
        levelBoost: rarityConfig.cardLevelBoost,
      })
    : null;

  chest.opened_at_ms = nowMs;
  chest.claimed_by_sid = openerSid;
  chest.opener_sid = openerSid;

  const cardLabel = cardReward?.title ? ` Bonus card: ${cardReward.title}.` : '';
  emitProgressionNotification(io, openerSid, {
    type: 'chest',
    title: `${rarityConfig.label} Chest Opened`,
    message: `You gained ${rewardSouls} souls and pulled ${xpResult.gainedXp} XP from the chest.${cardLabel}`,
    xp: xpResult.gainedXp,
    caption: `+${rewardSouls} souls`,
  });

  for (const achievement of unlockedAchievements) {
    emitProgressionNotification(io, openerSid, achievement);
  }

  io.emit('chest_opened', {
    id: chest.id,
    rarity: chest.rarity,
    x: round1(chest.x),
    y: round1(chest.y),
    reward_souls: rewardSouls,
    opened_by_sid: openerSid,
    opened_at_ms: nowMs,
  });
}

function rollChestRarity() {
  const roll = Math.random() * Object.values(CHEST_RARITY_CONFIG).reduce((sum, config) => sum + config.weight, 0);
  let threshold = 0;

  for (const [rarity, config] of Object.entries(CHEST_RARITY_CONFIG)) {
    threshold += config.weight;
    if (roll <= threshold) {
      return rarity;
    }
  }

  return 'normal';
}

function randomInt(min, max) {
  const safeMin = Math.round(Number(min) || 0);
  const safeMax = Math.round(Number(max) || safeMin);
  if (safeMax <= safeMin) {
    return safeMin;
  }
  return safeMin + Math.floor(Math.random() * (safeMax - safeMin + 1));
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

module.exports = {
  CHEST_ALERT_DURATION_MS,
  CHEST_DESPAWN_DURATION_MS,
  CHEST_INTERACT_RADIUS,
  CHEST_POST_OPEN_HOLD_MS,
  ensureChestState,
  handleChestInteractRequest,
  clearChestInteractionForPlayer,
  resetChestStateForMap,
  serializeChestsForState,
  updateChests,
};
