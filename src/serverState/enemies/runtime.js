const {
  GRAVITY,
  JUMP_FORCE,
  MOVE_SPEED,
  PLAYER_HITBOX_WIDTH,
  PLAYER_HITBOX_HEIGHT,
  FIREBALL_RADIUS,
} = require('../state/constants');
const { getNearbyPlatforms } = require('../state/platformGrid/buildPlatformGrid');
const { dropSoulsForEnemyDeath, dropSoulsForPlayerDeath } = require('../state/souls/soulSystem');
const { emitToNearbyPlayers } = require('../replication/nearby');
const {
  consumeAggroUnlockNotification,
  gainPlayerXp,
  getPlayerLevel,
  getPlayerRunStats,
  recordProgressionMetric,
} = require('../state/progression/system');
const { emitProgressionNotification } = require('../state/progression/notifications');

function secondsFromMs(ms) {
  return ms / 1000;
}

const MIN_ENEMY_RESPAWN_DELAY_SECONDS = 18;
const ENEMY_DEATH_HOLD_SECONDS = 10;
const ENEMY_PLATFORM_INSET = 10;
const ENEMY_SPAWN_EDGE_PADDING_X = 32;
const ENEMY_SPAWN_EDGE_PADDING_Y = 40;
const BAT_MIN_PLATFORM_WIDTH = 260;
const BAT_REQUIRED_HEADROOM = 220;
const SLIME_WALL_STICK_SECONDS = 0.6;
const SLIME_ATTACH_OFFSET_Y = -4;
const SLIME_SPLAT_RADIUS = 30;
const GARGOYLE_PERCH_OPACITY = 0.3;
const GARGOYLE_ACTIVE_OPACITY = 1;
const GARGOYLE_AMBUSH_TRIGGER_RADIUS = 42;
const GHOST_PASSIVE_OPACITY = 0.3;
const GHOST_ACTIVE_OPACITY = 1;
const STRIKER_ASCEND_DURATION_SECONDS = 0.7;
const STRIKER_SLAM_IMPACT_WINDOW_SECONDS = 0.18;
const STRIKER_TOUCH_DAMAGE_COOLDOWN_SECONDS = 0.65;
const STRIKER_ENVIRONMENT_ATTACK_COOLDOWN_SECONDS = 0.72;
const STRIKER_SQUEEZE_STEP_X = 22;
const STRIKER_SQUEEZE_STEP_Y = 16;
const ENEMY_DIRECTOR_SYNC_MS = 1200;
const ENEMY_LEVEL_SOFT_CAP = 10;
const ENEMY_LEVEL_HARD_CAP = 1000;
const SAFE_PLAYER_LEVEL_CAP = 4;
const ENEMY_SPAWN_GRACE_MS = 700;
const ENEMY_PRESSURE_ALERT_RADIUS_X = 1800;
const ENEMY_PRESSURE_ALERT_RADIUS_Y = 1200;
const ENEMY_EFFECT_RADIUS_X = 1750;
const ENEMY_EFFECT_RADIUS_Y = 1200;

const ENEMY_PRESSURE_ALERTS = Object.freeze({
  bat: {
    type: 'danger',
    title: 'Bats Are Swarming',
    caption: 'Threat Nearby',
    message: 'You stirred the bats. A swarm is gathering nearby.',
    cooldownMs: 45000,
  },
  spider: {
    type: 'danger',
    title: 'Spiders Turn Hostile',
    caption: 'Threat Nearby',
    message: 'You made the spiders angry. A brood is rushing in nearby.',
    cooldownMs: 45000,
  },
  gargoyle: {
    type: 'danger',
    title: 'Gargoyles Are Hunting',
    caption: 'Threat Nearby',
    message: 'Stone hunters are circling above. Gargoyles are closing in.',
    cooldownMs: 55000,
  },
  striker: {
    type: 'danger',
    title: 'A Striker Is Diving In',
    caption: 'Threat Nearby',
    message: 'A striker has locked onto the fight nearby. Keep moving.',
    cooldownMs: 60000,
  },
  ghost: {
    type: 'danger',
    title: 'Ghosts Are Manifesting',
    caption: 'Threat Nearby',
    message: 'Spectral entities are materializing nearby. Ghosts are closing in.',
    cooldownMs: 55000,
  },
});

function isFlyingEnemy(definition) {
  return definition?.behavior?.movementMode === 'flying';
}

function usesProjectileAttack(definition) {
  return definition?.behavior?.attackMode === 'projectile';
}

function isSlimeEnemy(input) {
  if (!input) {
    return false;
  }
  if (typeof input === 'string') {
    return input === 'slime';
  }
  return input.type === 'slime' || input.id === 'slime';
}

function isGargoyleEnemy(input) {
  if (!input) {
    return false;
  }
  if (typeof input === 'string') {
    return input === 'gargoyle';
  }
  return input.type === 'gargoyle' || input.id === 'gargoyle';
}

function isStrikerEnemy(input) {
  if (!input) {
    return false;
  }
  if (typeof input === 'string') {
    return input === 'striker';
  }
  return input.type === 'striker' || input.id === 'striker';
}

function isGhostEnemy(input) {
  if (!input) {
    return false;
  }
  if (typeof input === 'string') {
    return input === 'ghost';
  }
  return input.type === 'ghost' || input.id === 'ghost';
}

function usesProjectileAttackForEnemy(enemy, definition) {
  if (isGargoyleEnemy(definition)) {
    return enemy?.gargoyle_mode !== 'swoop';
  }
  return usesProjectileAttack(definition);
}

function getFacingFromSign(sign, fallbackDirection = 'right') {
  if (sign < 0) {
    return 'left';
  }
  if (sign > 0) {
    return 'right';
  }
  return fallbackDirection === 'left' ? 'left' : 'right';
}

function chooseEnemyDeathDirection(enemy, sourceVx) {
  const currentDirection = enemy.direction === 'left' ? 'left' : 'right';
  const impactSign = Math.sign(Number(sourceVx) || 0);
  const baseDirection = getFacingFromSign(impactSign, currentDirection);

  if (impactSign === 0) {
    return Math.random() < 0.5 ? currentDirection : (currentDirection === 'left' ? 'right' : 'left');
  }

  if (Math.abs(Number(sourceVx) || 0) >= 180 && Math.random() < 0.28) {
    return baseDirection === 'left' ? 'right' : 'left';
  }

  if (Math.random() < 0.18) {
    return currentDirection;
  }

  return baseDirection;
}

function getEnemyDefinition(state, enemyType) {
  return state.enemyDefinitions?.[enemyType] ?? null;
}

function getEnemyShape(definition) {
  const frameWidth = definition.frameSize?.w ?? 64;
  const frameHeight = definition.frameSize?.h ?? 64;
  const scale = definition.scale ?? 0.24;
  const normalized = definition.normalized ?? { x: 0.2, y: 0.35, w: 0.6, h: 0.5 };
  const renderWidth = frameWidth * scale;
  const renderHeight = frameHeight * scale;
  const localX = -renderWidth / 2 + renderWidth * normalized.x;
  const localY = -renderHeight / 2 + renderHeight * normalized.y;

  return {
    renderWidth,
    renderHeight,
    localX,
    localY,
    width: renderWidth * normalized.w,
    height: renderHeight * normalized.h,
  };
}

function getEnemyHitboxForPosition(definition, x, y) {
  const shape = getEnemyShape(definition);
  return {
    ...shape,
    x: x + shape.localX,
    y: y + shape.localY,
  };
}

function getEnemyHitbox(state, enemy) {
  const definition = enemy.runtime_definition || getEnemyDefinition(state, enemy.type);
  if (!definition) {
    return null;
  }
  return getEnemyHitboxForPosition(definition, enemy.x, enemy.y);
}

function getEnemyProjectileOrigin(enemy, definition) {
  const directionSign = enemy.direction === 'left' ? -1 : 1;
  return {
    x: enemy.x + directionSign * (definition.behavior.projectileOffsetX ?? 0),
    y: enemy.y + (definition.behavior.projectileYOffset ?? 0),
  };
}

function setEnemyCenterFromHitbox(definition, enemy, hitboxX, hitboxY) {
  const shape = getEnemyShape(definition);
  enemy.x = hitboxX - shape.localX;
  enemy.y = hitboxY - shape.localY;
}

function checkEnemyPlatformCollision(definition, enemyX, enemyY, platform) {
  const hitbox = getEnemyHitboxForPosition(definition, enemyX, enemyY);
  return (
    hitbox.x < platform.x + platform.w &&
    hitbox.x + hitbox.width > platform.x &&
    hitbox.y < platform.y + platform.h &&
    hitbox.y + hitbox.height > platform.y
  );
}

function checkEnemyPlayerCollision(state, enemy, player) {
  const enemyHitbox = getEnemyHitbox(state, enemy);
  if (!enemyHitbox) {
    return false;
  }

  const playerHitboxX = player.x - PLAYER_HITBOX_WIDTH / 2;
  const playerHitboxY = player.y - PLAYER_HITBOX_HEIGHT / 2;
  return (
    enemyHitbox.x < playerHitboxX + PLAYER_HITBOX_WIDTH &&
    enemyHitbox.x + enemyHitbox.width > playerHitboxX &&
    enemyHitbox.y < playerHitboxY + PLAYER_HITBOX_HEIGHT &&
    enemyHitbox.y + enemyHitbox.height > playerHitboxY
  );
}

function checkFireballEnemyCollision(state, fireball, enemy) {
  const hitbox = getEnemyHitbox(state, enemy);
  if (!hitbox) {
    return false;
  }

  const closestX = Math.max(hitbox.x, Math.min(fireball.x, hitbox.x + hitbox.width));
  const closestY = Math.max(hitbox.y, Math.min(fireball.y, hitbox.y + hitbox.height));
  const dx = fireball.x - closestX;
  const dy = fireball.y - closestY;
  const radius = FIREBALL_RADIUS * Math.max(0.2, Number(fireball.radius_scale) || 1);
  return dx * dx + dy * dy <= radius * radius;
}

function clampEnemyToBounds(state, definition, enemy) {
  const hitbox = getEnemyHitbox(state, enemy);
  if (!hitbox) {
    return;
  }

  if (hitbox.x < state.mapBounds.min_x) {
    setEnemyCenterFromHitbox(definition, enemy, state.mapBounds.min_x, hitbox.y);
    enemy.vx = 0;
    enemy.knockback_vx = 0;
  } else if (hitbox.x + hitbox.width > state.mapBounds.max_x) {
    setEnemyCenterFromHitbox(definition, enemy, state.mapBounds.max_x - hitbox.width, hitbox.y);
    enemy.vx = 0;
    enemy.knockback_vx = 0;
  }

  const refreshed = getEnemyHitbox(state, enemy);
  if (!refreshed) {
    return;
  }

  if (refreshed.y < state.mapBounds.min_y) {
    setEnemyCenterFromHitbox(definition, enemy, refreshed.x, state.mapBounds.min_y);
    enemy.vy = 0;
  } else if (refreshed.y + refreshed.height > state.mapBounds.max_y) {
    setEnemyCenterFromHitbox(definition, enemy, refreshed.x, state.mapBounds.max_y - refreshed.height);
    enemy.vy = 0;
    enemy.on_ground = true;
    enemy.jumps_remaining = 2;
  }
}

function resolveEnemyHorizontalCollisions(state, definition, enemy, prevX, nearbyPlatforms) {
  const isGhostAttacking = isGhostEnemy(definition) && (
    enemy.brain_state === 'prepare' ||
    enemy.brain_state === 'lunge' ||
    enemy.brain_state === 'recover'
  );
  if (isGhostAttacking) {
    return;
  }

  const prevHitbox = getEnemyHitboxForPosition(definition, prevX, enemy.y);

  for (const platform of nearbyPlatforms) {
    if (!checkEnemyPlatformCollision(definition, enemy.x, enemy.y, platform)) {
      continue;
    }

    const wasOutside =
      prevHitbox.x + prevHitbox.width <= platform.x ||
      prevHitbox.x >= platform.x + platform.w;

    if (!wasOutside) {
      continue;
    }

    const currentHitbox = getEnemyHitbox(state, enemy);
    if (!currentHitbox) {
      continue;
    }

    if (enemy.vx > 0) {
      setEnemyCenterFromHitbox(definition, enemy, platform.x - currentHitbox.width, currentHitbox.y);
    } else if (enemy.vx < 0) {
      setEnemyCenterFromHitbox(definition, enemy, platform.x + platform.w, currentHitbox.y);
    }

    enemy.vx = 0;
    enemy.knockback_vx = 0;
  }
}

function resolveEnemyVerticalCollisions(state, definition, enemy, prevY, nearbyPlatforms) {
  const isGhostAttacking = isGhostEnemy(definition) && (
    enemy.brain_state === 'prepare' ||
    enemy.brain_state === 'lunge' ||
    enemy.brain_state === 'recover'
  );
  if (isGhostAttacking) {
    return;
  }

  const prevHitbox = getEnemyHitboxForPosition(definition, enemy.x, prevY);

  for (const platform of nearbyPlatforms) {
    if (!checkEnemyPlatformCollision(definition, enemy.x, enemy.y, platform)) {
      continue;
    }

    const wasOutside =
      prevHitbox.y + prevHitbox.height <= platform.y ||
      prevHitbox.y >= platform.y + platform.h;

    if (!wasOutside) {
      continue;
    }

    const currentHitbox = getEnemyHitbox(state, enemy);
    if (!currentHitbox) {
      continue;
    }

    if (enemy.vy > 0) {
      setEnemyCenterFromHitbox(definition, enemy, currentHitbox.x, platform.y - currentHitbox.height);
      enemy.vy = 0;
      enemy.on_ground = true;
      enemy.jumps_remaining = 2;
      enemy.jump_start_y = enemy.y;
      enemy.jump_target_top_y = 0;
      enemy.jump_requires_double = false;
      enemy.jump_launch_vx = 0;
    } else if (enemy.vy < 0) {
      setEnemyCenterFromHitbox(definition, enemy, currentHitbox.x, platform.y + platform.h);
      enemy.vy = 0;
    }
  }
}

function willEnemyCollideHorizontally(state, definition, enemy, deltaX) {
  const targetX = enemy.x + deltaX;
  const nearbyPlatforms = getNearbyPlatforms({
    platformGrid: state.platformGrid,
    x: targetX,
    y: enemy.y,
  });

  return nearbyPlatforms.some((platform) =>
    checkEnemyPlatformCollision(definition, targetX, enemy.y, platform)
  );
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getEnemyTypeUnlockLevel(enemyType) {
  if (enemyType === 'bat') return 3;
  if (enemyType === 'gargoyle') return 9;
  if (enemyType === 'striker') return 12;
  return 1;
}

function getEnemyLevelScale(level) {
  const safeLevel = clamp(Math.max(1, Math.round(Number(level) || 1)), 1, ENEMY_LEVEL_HARD_CAP);
  if (safeLevel <= ENEMY_LEVEL_SOFT_CAP) {
    const normalized = (safeLevel - 1) / Math.max(1, ENEMY_LEVEL_SOFT_CAP - 1);
    return 0.46 + normalized * 0.54;
  }

  const overCapNormalized = (safeLevel - ENEMY_LEVEL_SOFT_CAP) / Math.max(1, ENEMY_LEVEL_HARD_CAP - ENEMY_LEVEL_SOFT_CAP);
  return 1 + Math.pow(overCapNormalized, 0.82) * 1.9;
}

function buildScaledEnemyDefinition(definition, level) {
  const scale = getEnemyLevelScale(level);
  const growth = Math.max(0, scale - 0.46);
  const enemyType = definition.type || definition.id || '';
  const speedScale = 0.84 + growth * 0.34;
  const detectionScale = 0.78 + growth * 0.24;
  const cooldownScale = clamp(1.16 - growth * 0.2, 0.62, 1.16);
  const levelBoost = Math.max(0, level - 1);

  const scaledBehavior = {
    ...definition.behavior,
    detectionRadius: Math.max(120, Math.round(definition.behavior.detectionRadius * detectionScale)),
    leashRadius: Math.max(180, Math.round(definition.behavior.leashRadius * detectionScale)),
    wanderRadius: Math.max(90, Math.round(definition.behavior.wanderRadius * (0.92 + growth * 0.1))),
    moveSpeed: Math.max(70, definition.behavior.moveSpeed * speedScale),
    verticalMoveSpeed: Math.max(70, definition.behavior.verticalMoveSpeed * speedScale),
    telegraphDurationMs: Math.max(200, Math.round(definition.behavior.telegraphDurationMs * cooldownScale)),
    lungeDurationMs: Math.max(220, Math.round(definition.behavior.lungeDurationMs * clamp(1.03 - growth * 0.08, 0.66, 1.08))),
    attackCooldownMs: Math.max(420, Math.round(definition.behavior.attackCooldownMs * cooldownScale)),
    attackRange: Math.max(140, Math.round(definition.behavior.attackRange * (0.9 + growth * 0.16))),
    lungeSpeed: Math.max(240, definition.behavior.lungeSpeed * (0.9 + growth * 0.28)),
    lungeLift: Math.max(0, definition.behavior.lungeLift * (0.9 + growth * 0.2)),
    jumpForce: Math.max(340, definition.behavior.jumpForce * (0.92 + growth * 0.16)),
    hoverHeight: Math.max(64, definition.behavior.hoverHeight * (0.94 + growth * 0.1)),
    hoverVariance: Math.max(40, definition.behavior.hoverVariance * (0.92 + growth * 0.1)),
    projectileSpeed: Math.max(0, definition.behavior.projectileSpeed * (0.9 + growth * 0.24)),
    projectileDamage: Math.max(0, Math.round(definition.behavior.projectileDamage * (0.72 + growth * 0.86))),
    projectileScale: Math.max(0.45, definition.behavior.projectileScale * (0.92 + growth * 0.1)),
    projectileRadiusScale: Math.max(0.45, definition.behavior.projectileRadiusScale * (0.92 + growth * 0.1)),
    projectileAimJitterRadians: enemyType === 'bat'
      ? clamp(0.26 - growth * 0.1 - levelBoost * 0.011, 0.035, 0.26)
      : 0,
  };

  if (enemyType === 'gargoyle') {
    scaledBehavior.telegraphDurationMs = Math.max(150, Math.round(scaledBehavior.telegraphDurationMs * 0.76));
    scaledBehavior.attackCooldownMs = Math.max(320, Math.round(scaledBehavior.attackCooldownMs * clamp(0.82 - levelBoost * 0.02, 0.5, 0.82)));
    scaledBehavior.projectileSpeed = Math.max(0, scaledBehavior.projectileSpeed * (1 + Math.min(0.24, levelBoost * 0.018)));
    scaledBehavior.projectileRadiusScale = Math.max(0.52, scaledBehavior.projectileRadiusScale * (1 + Math.min(0.18, levelBoost * 0.012)));
  } else if (enemyType === 'bat') {
    scaledBehavior.detectionRadius = Math.max(140, Math.round(scaledBehavior.detectionRadius * (1 + Math.min(0.18, levelBoost * 0.016))));
    scaledBehavior.leashRadius = Math.max(220, Math.round(scaledBehavior.leashRadius * (1 + Math.min(0.18, levelBoost * 0.014))));
    scaledBehavior.moveSpeed = Math.max(88, scaledBehavior.moveSpeed * (1 + Math.min(0.32, levelBoost * 0.024)));
    scaledBehavior.verticalMoveSpeed = Math.max(88, scaledBehavior.verticalMoveSpeed * (1 + Math.min(0.36, levelBoost * 0.028)));
    scaledBehavior.telegraphDurationMs = Math.max(140, Math.round(scaledBehavior.telegraphDurationMs * 0.72));
    scaledBehavior.attackCooldownMs = Math.max(300, Math.round(scaledBehavior.attackCooldownMs * clamp(0.74 - levelBoost * 0.015, 0.42, 0.74)));
    scaledBehavior.projectileSpeed = Math.max(0, scaledBehavior.projectileSpeed * (1 + Math.min(0.34, levelBoost * 0.026)));
    scaledBehavior.attackRange = Math.max(180, Math.round(scaledBehavior.attackRange * (1 + Math.min(0.12, levelBoost * 0.01))));
  } else if (enemyType === 'spider') {
    scaledBehavior.detectionRadius = Math.max(140, Math.round(scaledBehavior.detectionRadius * (1 + Math.min(0.2, levelBoost * 0.018))));
    scaledBehavior.moveSpeed = Math.max(88, scaledBehavior.moveSpeed * (1 + Math.min(0.28, levelBoost * 0.022)));
    scaledBehavior.telegraphDurationMs = Math.max(150, Math.round(scaledBehavior.telegraphDurationMs * 0.76));
    scaledBehavior.attackCooldownMs = Math.max(320, Math.round(scaledBehavior.attackCooldownMs * clamp(0.78 - levelBoost * 0.014, 0.46, 0.78)));
    scaledBehavior.attackRange = Math.max(160, Math.round(scaledBehavior.attackRange * (1 + Math.min(0.14, levelBoost * 0.012))));
    scaledBehavior.lungeSpeed = Math.max(280, scaledBehavior.lungeSpeed * (1 + Math.min(0.3, levelBoost * 0.024)));
    scaledBehavior.jumpForce = Math.max(420, scaledBehavior.jumpForce * (1 + Math.min(0.22, levelBoost * 0.016)));
  }

  return {
    ...definition,
    stats: {
      ...definition.stats,
      maxHealth: Math.max(1, Math.round(definition.stats.maxHealth * scale)),
      contactDamage: Math.max(1, Math.round(definition.stats.contactDamage * (0.7 + growth * 0.78))),
    },
    behavior: scaledBehavior,
    level,
  };
}

function getWorldThreatLevel(state) {
  let highestThreat = 1;
  for (const player of state.players.values()) {
    if (!player || player.is_dying) {
      continue;
    }
    const level = getPlayerLevel(player);
    const souls = Math.max(0, Math.round(Number(player.soul_count) || 0));
    const threat = level + Math.floor(souls / 14);
    if (threat > highestThreat) {
      highestThreat = threat;
    }
  }
  return clamp(highestThreat, 1, ENEMY_LEVEL_HARD_CAP);
}

function getEnemyLevelForType(worldThreatLevel, enemyType) {
  const unlockLevel = getEnemyTypeUnlockLevel(enemyType);
  if (worldThreatLevel < unlockLevel) {
    return 0;
  }

  const typeBias = enemyType === 'striker'
    ? 4
    : enemyType === 'ghost'
      ? 5
    : enemyType === 'gargoyle'
      ? 1
      : enemyType === 'bat'
        ? -1
        : 0;
  return clamp(Math.max(1, worldThreatLevel + typeBias), 1, ENEMY_LEVEL_HARD_CAP);
}

function rollEnemySpawnLevel(worldThreatLevel, enemyType) {
  const maxLevel = getEnemyLevelForType(worldThreatLevel, enemyType);
  if (maxLevel <= 0) {
    return 0;
  }

  if (maxLevel <= 2) {
    return maxLevel;
  }

  const weightedRoll = Math.min(Math.random(), Math.random(), Math.random());
  return clamp(1 + Math.round((maxLevel - 1) * (1 - weightedRoll)), 1, maxLevel);
}

function ensureEnemyDirector(state) {
  if (!state.enemyDirector || typeof state.enemyDirector !== 'object') {
    state.enemyDirector = {
      lastSyncAtMs: 0,
      lastThreatLevel: 1,
      lastPressureAlertAtByType: {},
    };
  }
  if (!state.enemyDirector.lastPressureAlertAtByType || typeof state.enemyDirector.lastPressureAlertAtByType !== 'object') {
    state.enemyDirector.lastPressureAlertAtByType = {};
  }
  return state.enemyDirector;
}

function maybeBroadcastEnemyPressureAlert(state, io, enemyType, spawnInfo) {
  const alert = ENEMY_PRESSURE_ALERTS[enemyType];
  if (!alert || !io || !spawnInfo) {
    return;
  }

  const director = ensureEnemyDirector(state);
  const nowMs = Date.now();
  const lastAlertAtMs = Number(director.lastPressureAlertAtByType?.[enemyType]) || 0;
  if (nowMs - lastAlertAtMs < alert.cooldownMs) {
    return;
  }

  director.lastPressureAlertAtByType[enemyType] = nowMs;
  emitToNearbyPlayers({
    io,
    state,
    x: spawnInfo.x,
    y: spawnInfo.y,
    radiusX: ENEMY_PRESSURE_ALERT_RADIUS_X,
    radiusY: ENEMY_PRESSURE_ALERT_RADIUS_Y,
    event: 'progression_notification',
    payload: {
      type: alert.type,
      title: alert.title,
      caption: alert.caption,
      message: alert.message,
      xp: 0,
      timestamp: nowMs,
    },
    includeSids: typeof spawnInfo.anchorSid === 'string' ? [spawnInfo.anchorSid] : [],
  });
}

function getPlayerHitbox(player) {
  return {
    x: player.x - PLAYER_HITBOX_WIDTH / 2,
    y: player.y - PLAYER_HITBOX_HEIGHT / 2,
    width: PLAYER_HITBOX_WIDTH,
    height: PLAYER_HITBOX_HEIGHT,
  };
}

function getPlayerReachEnvelope() {
  const gravityPerSecond = GRAVITY * 60;
  const singleJumpHeight = (Math.abs(JUMP_FORCE) * Math.abs(JUMP_FORCE)) / Math.max(1, 2 * gravityPerSecond);
  const singleJumpAirTime = (2 * Math.abs(JUMP_FORCE)) / Math.max(1, gravityPerSecond);
  const doubleJumpHeight = singleJumpHeight * 1.9 + 28;
  const horizontalReach = MOVE_SPEED * (singleJumpAirTime * 1.45);

  return {
    singleJumpHeight,
    doubleJumpHeight,
    horizontalReach,
  };
}

function getReachablePlayerPlatforms(state, player) {
  if (!Array.isArray(state.platforms)) {
    return [];
  }

  const hitbox = getPlayerHitbox(player);
  const feetY = hitbox.y + hitbox.height;
  const centerX = hitbox.x + hitbox.width / 2;
  const envelope = getPlayerReachEnvelope();
  const candidates = [];

  for (const platform of state.platforms) {
    const horizontalGap =
      centerX < platform.x ? platform.x - centerX :
      centerX > platform.x + platform.w ? centerX - (platform.x + platform.w) :
      0;

    if (horizontalGap > envelope.horizontalReach + 18) {
      continue;
    }

    const rise = feetY - platform.y;
    if (rise < -40) {
      continue;
    }
    if (rise > envelope.doubleJumpHeight + 36) {
      continue;
    }

    candidates.push(platform);
  }

  candidates.sort((a, b) => {
    const aRise = Math.max(0, feetY - a.y);
    const bRise = Math.max(0, feetY - b.y);
    const aHorizontalGap =
      centerX < a.x ? a.x - centerX :
      centerX > a.x + a.w ? centerX - (a.x + a.w) :
      0;
    const bHorizontalGap =
      centerX < b.x ? b.x - centerX :
      centerX > b.x + b.w ? centerX - (b.x + b.w) :
      0;
    return (aRise + aHorizontalGap * 0.45) - (bRise + bHorizontalGap * 0.45);
  });

  return candidates.slice(0, 10);
}

function getPlayerPlatformCache(state) {
  if (!(state.playerPlatformCache instanceof Map)) {
    state.playerPlatformCache = new Map();
  }
  return state.playerPlatformCache;
}

function getCachedReachablePlayerPlatforms(state, cacheKey, player) {
  const cache = getPlayerPlatformCache(state);
  const bucketX = Math.round((player.x ?? 0) / 32);
  const bucketY = Math.round((player.y ?? 0) / 24);
  const key = `${cacheKey}:${bucketX}:${bucketY}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const reachablePlatforms = getReachablePlayerPlatforms(state, player);
  cache.set(key, reachablePlatforms);

  if (cache.size > 256) {
    const oldestKey = cache.keys().next().value;
    cache.delete(oldestKey);
  }

  return reachablePlatforms;
}

function getSupportPlatformForHitbox(state, hitbox) {
  if (!hitbox) {
    return null;
  }

  const nearbyPlatforms = getNearbyPlatforms({
    platformGrid: state.platformGrid,
    x: hitbox.x + hitbox.width / 2,
    y: hitbox.y + hitbox.height + 6,
  });

  let bestPlatform = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const platform of nearbyPlatforms) {
    const horizontalOverlap = Math.min(hitbox.x + hitbox.width, platform.x + platform.w) - Math.max(hitbox.x, platform.x);
    if (horizontalOverlap < Math.max(8, hitbox.width * 0.28)) {
      continue;
    }

    const gap = Math.abs(hitbox.y + hitbox.height - platform.y);
    if (gap > 14) {
      continue;
    }

    if (!bestPlatform || gap < bestGap || platform.y < bestPlatform.y) {
      bestPlatform = platform;
      bestGap = gap;
    }
  }

  return bestPlatform;
}

function getEnemySupportPlatform(state, enemy, definition) {
  return getSupportPlatformForHitbox(state, getEnemyHitboxForPosition(definition, enemy.x, enemy.y));
}

function lineIntersectsRect(x1, y1, x2, y2, rect) {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);

  if (maxX < rect.x || minX > rect.x + rect.w || maxY < rect.y || minY > rect.y + rect.h) {
    return false;
  }

  const dx = x2 - x1;
  const dy = y2 - y1;
  let t0 = 0;
  let t1 = 1;
  const checks = [
    [-dx, x1 - rect.x],
    [dx, rect.x + rect.w - x1],
    [-dy, y1 - rect.y],
    [dy, rect.y + rect.h - y1],
  ];

  for (const [p, q] of checks) {
    if (p === 0) {
      if (q < 0) {
        return false;
      }
      continue;
    }

    const ratio = q / p;
    if (p < 0) {
      if (ratio > t1) {
        return false;
      }
      if (ratio > t0) {
        t0 = ratio;
      }
    } else {
      if (ratio < t0) {
        return false;
      }
      if (ratio < t1) {
        t1 = ratio;
      }
    }
  }

  return true;
}

function hasLineOfSightToPlayer(state, enemy, player) {
  if (!Array.isArray(state.platforms) || state.platforms.length === 0) {
    return true;
  }

  const fromX = enemy.x;
  const fromY = enemy.y - 14;
  const toX = player.x;
  const toY = player.y - PLAYER_HITBOX_HEIGHT * 0.2;
  const minX = Math.min(fromX, toX);
  const maxX = Math.max(fromX, toX);
  const minY = Math.min(fromY, toY);
  const maxY = Math.max(fromY, toY);

  for (const platform of state.platforms) {
    const overlapsSpan =
      platform.x < maxX - 4 &&
      platform.x + platform.w > minX + 4 &&
      platform.y < maxY - 4 &&
      platform.y + platform.h > minY + 4;

    if (!overlapsSpan) {
      continue;
    }

    if (lineIntersectsRect(fromX, fromY, toX, toY, platform)) {
      return false;
    }
  }

  return true;
}

function getEnemyCenterYForHitboxTop(definition, hitboxTopY) {
  return hitboxTopY - getEnemyShape(definition).localY;
}

function getFlyingEnemyCeilingSafeCenterY(state, definition) {
  const shape = getEnemyShape(definition);
  const ceilingPadding = Math.max(28, shape.height * 0.45);
  return getEnemyCenterYForHitboxTop(definition, state.mapBounds.min_y + ceilingPadding);
}

function clampFlyingCenterYToSafeBand(state, definition, centerY) {
  const shape = getEnemyShape(definition);
  const minCenterY = getFlyingEnemyCeilingSafeCenterY(state, definition);
  const bottomPadding = Math.max(28, shape.height * 0.3);
  const maxCenterY = getEnemyCenterYForHitboxTop(
    definition,
    state.mapBounds.max_y - shape.height - bottomPadding
  );
  return clamp(centerY, minCenterY, maxCenterY);
}

function getFlyingCeilingTrapEscape(state, enemy, definition) {
  const hitbox = getEnemyHitboxForPosition(definition, enemy.x, enemy.y);
  if (!hitbox) {
    return null;
  }

  const nearbyPlatforms = getNearbyPlatforms({
    platformGrid: state.platformGrid,
    x: enemy.x,
    y: enemy.y,
  });

  let bestPlatform = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const platform of nearbyPlatforms) {
    const horizontalOverlap = Math.min(hitbox.x + hitbox.width, platform.x + platform.w) - Math.max(hitbox.x, platform.x);
    if (horizontalOverlap < Math.max(10, hitbox.width * 0.42)) {
      continue;
    }

    const verticalGap = hitbox.y - (platform.y + platform.h);
    if (verticalGap < -8 || verticalGap > Math.max(26, hitbox.height * 0.5)) {
      continue;
    }

    if (verticalGap < bestGap) {
      bestGap = verticalGap;
      bestPlatform = platform;
    }
  }

  if (!bestPlatform) {
    return null;
  }

  const shape = getEnemyShape(definition);
  const leftExitX = bestPlatform.x - shape.width * 0.7 - 18;
  const rightExitX = bestPlatform.x + bestPlatform.w + shape.width * 0.7 + 18;
  const leftDistance = Math.abs(enemy.x - leftExitX);
  const rightDistance = Math.abs(enemy.x - rightExitX);
  const chosenX = leftDistance <= rightDistance ? leftExitX : rightExitX;
  const downY = getEnemyCenterYForHitboxTop(
    definition,
    bestPlatform.y + bestPlatform.h + Math.max(26, shape.height * 0.38)
  );

  return {
    escapeX: clamp(chosenX, state.mapBounds.min_x + shape.width * 0.6, state.mapBounds.max_x - shape.width * 0.6),
    escapeY: clampFlyingCenterYToSafeBand(state, definition, downY),
  };
}

function getExpandedRect(rect, expandX, expandY) {
  return {
    x: rect.x - expandX,
    y: rect.y - expandY,
    w: rect.w + expandX * 2,
    h: rect.h + expandY * 2,
  };
}

function getFirstBlockingPlatformBetween(state, definition, fromX, fromY, toX, toY) {
  if (!Array.isArray(state.platforms) || state.platforms.length === 0) {
    return null;
  }

  const shape = getEnemyShape(definition);
  const expandX = Math.max(10, shape.width * 0.42);
  const expandY = Math.max(10, shape.height * 0.42);
  const minX = Math.min(fromX, toX);
  const maxX = Math.max(fromX, toX);
  const minY = Math.min(fromY, toY);
  const maxY = Math.max(fromY, toY);
  let bestPlatform = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const platform of state.platforms) {
    const expanded = getExpandedRect(platform, expandX, expandY);
    const overlapsSpan =
      expanded.x < maxX - 4 &&
      expanded.x + expanded.w > minX + 4 &&
      expanded.y < maxY - 4 &&
      expanded.y + expanded.h > minY + 4;

    if (!overlapsSpan || !lineIntersectsRect(fromX, fromY, toX, toY, expanded)) {
      continue;
    }

    const distance = Math.abs((platform.x + platform.w / 2) - fromX);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestPlatform = platform;
    }
  }

  return bestPlatform;
}

function canFlyingEnemyFitAt(state, definition, x, y) {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return false;
  }

  const hitbox = getEnemyHitboxForPosition(definition, x, y);
  if (!hitbox) {
    return false;
  }
  if (
    hitbox.x < state.mapBounds.min_x ||
    hitbox.y < state.mapBounds.min_y ||
    hitbox.x + hitbox.width > state.mapBounds.max_x ||
    hitbox.y + hitbox.height > state.mapBounds.max_y
  ) {
    return false;
  }

  const nearbyPlatforms = getNearbyPlatforms({
    platformGrid: state.platformGrid,
    x,
    y,
  });

  return !nearbyPlatforms.some((platform) => checkEnemyPlatformCollision(definition, x, y, platform));
}

function canFlyingEnemyTravelDirect(state, definition, fromX, fromY, toX, toY) {
  const blockingPlatform = getFirstBlockingPlatformBetween(state, definition, fromX, fromY, toX, toY);
  return !blockingPlatform && canFlyingEnemyFitAt(state, definition, toX, toY);
}

function chooseFlyingAltitudeBias(enemy, definition) {
  const aboveHigh = -definition.behavior.hoverHeight;
  const aboveMid = -Math.max(36, definition.behavior.hoverHeight * 0.72);
  const aboveLow = -Math.max(22, definition.behavior.hoverHeight * 0.48);
  const level = -Math.max(8, definition.behavior.hoverVariance * 0.06);
  const belowLight = Math.max(20, definition.behavior.hoverVariance * 0.22);
  const options = [aboveHigh, aboveMid, aboveLow, level, belowLight];
  const index = Math.floor(Math.random() * options.length);
  enemy.attack_altitude_bias = options[index];
  enemy.next_altitude_swap_at = 0;
}

function maybeRefreshFlyingAttackBias(enemy, definition, nowSec) {
  if (!Number.isFinite(enemy.next_altitude_swap_at) || nowSec >= enemy.next_altitude_swap_at) {
    chooseFlyingAltitudeBias(enemy, definition);
    enemy.next_altitude_swap_at = nowSec + 1.35 + Math.random() * 1.9;
  }
}

function getFlyingOrbitTarget(state, enemy, definition, targetPlayer, nowSec) {
  maybeRefreshFlyingAttackBias(enemy, definition, nowSec);

  if (isStrikerEnemy(definition)) {
    const bobAmplitude = definition.behavior.hoverBobAmplitude * 0.45;
    const bobSpeed = definition.behavior.hoverBobSpeed * 0.85;
    const bobOffset = Math.sin(nowSec * bobSpeed + stableEnemyPhase(enemy)) * bobAmplitude;
    const directChargeWindow =
      hasLineOfSightToPlayer(state, enemy, targetPlayer) &&
      (
        Math.abs(targetPlayer.x - enemy.x) <= Math.max(170, definition.behavior.attackRange * 0.42) ||
        Math.abs(targetPlayer.y - enemy.y) <= Math.max(110, definition.behavior.hoverVariance * 1.05)
      );
    const rawY = directChargeWindow
      ? targetPlayer.y - Math.max(38, definition.behavior.hoverHeight * 0.34) + bobOffset * 0.48
      : targetPlayer.y - Math.max(definition.behavior.hoverHeight, definition.behavior.attackRange * 0.28) + bobOffset;
    const minY = directChargeWindow
      ? targetPlayer.y - Math.max(120, definition.behavior.hoverHeight * 0.72)
      : targetPlayer.y - definition.behavior.hoverHeight - definition.behavior.hoverVariance * 0.42;
    const maxY = directChargeWindow
      ? targetPlayer.y + Math.max(12, definition.behavior.hoverVariance * 0.08)
      : targetPlayer.y - Math.max(48, definition.behavior.hoverHeight * 0.38);
    return {
      x: targetPlayer.x,
      y: clampFlyingCenterYToSafeBand(state, definition, clamp(rawY, minY, maxY)),
    };
  }

  const bobAmplitude = definition.behavior.hoverBobAmplitude;
  const bobSpeed = definition.behavior.hoverBobSpeed;
  const bobOffset = Math.sin(nowSec * bobSpeed + stableEnemyPhase(enemy)) * bobAmplitude;
  const offsetX = enemy.preferred_hover_offset_x || 0;
  const sweepOffsetX = Math.sin(nowSec * 1.15 + stableEnemyPhase(enemy) * 0.7) * 30;
  const rawY = targetPlayer.y + (enemy.attack_altitude_bias ?? -definition.behavior.hoverHeight) + bobOffset;
  const minY = targetPlayer.y - definition.behavior.hoverHeight - definition.behavior.hoverVariance;
  const maxY = targetPlayer.y + Math.min(52, definition.behavior.hoverVariance * 0.28);

  return {
    x: targetPlayer.x - offsetX + sweepOffsetX,
    y: clampFlyingCenterYToSafeBand(state, definition, clamp(rawY, minY, maxY)),
  };
}

function buildFlyingDetourPlan(state, enemy, definition, targetPoint) {
  const blocker = getFirstBlockingPlatformBetween(state, definition, enemy.x, enemy.y, targetPoint.x, targetPoint.y);
  if (!blocker) {
    return null;
  }

  const shape = getEnemyShape(definition);
  const clearance = Math.max(18, shape.height * 0.42);
  const aboveY = clampFlyingCenterYToSafeBand(
    state,
    definition,
    getEnemyCenterYForHitboxTop(definition, blocker.y - shape.height - clearance)
  );
  const belowY = clampFlyingCenterYToSafeBand(
    state,
    definition,
    getEnemyCenterYForHitboxTop(definition, blocker.y + blocker.h + clearance)
  );
  const movingRight = targetPoint.x >= enemy.x;
  const nearSideX = movingRight
    ? blocker.x - shape.width * 0.7 - clearance
    : blocker.x + blocker.w + shape.width * 0.7 + clearance;
  const farSideX = movingRight
    ? blocker.x + blocker.w + shape.width * 0.7 + clearance
    : blocker.x - shape.width * 0.7 - clearance;

  const candidateLanes = [
    { mode: 'above', y: aboveY },
    { mode: 'below', y: belowY },
  ].filter((lane) => canFlyingEnemyFitAt(state, definition, enemy.x, lane.y));

  let bestPlan = null;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const lane of candidateLanes) {
    const laneNearX = clamp(nearSideX, state.mapBounds.min_x, state.mapBounds.max_x);
    const laneFarX = clamp(farSideX, state.mapBounds.min_x, state.mapBounds.max_x);
    const nearPoint = { x: laneNearX, y: lane.y };
    const farPoint = { x: laneFarX, y: lane.y };
    if (
      !canFlyingEnemyFitAt(state, definition, nearPoint.x, nearPoint.y) ||
      !canFlyingEnemyFitAt(state, definition, farPoint.x, farPoint.y)
    ) {
      continue;
    }

    const firstLegClear = canFlyingEnemyTravelDirect(state, definition, enemy.x, enemy.y, nearPoint.x, nearPoint.y);
    const secondLegClear = canFlyingEnemyTravelDirect(state, definition, nearPoint.x, nearPoint.y, farPoint.x, farPoint.y);
    const thirdLegClear = canFlyingEnemyTravelDirect(state, definition, farPoint.x, farPoint.y, targetPoint.x, targetPoint.y);
    const score =
      (firstLegClear ? 0 : 180) +
      (secondLegClear ? 0 : 90) +
      (thirdLegClear ? 0 : 60) +
      Math.abs(targetPoint.y - lane.y) * 0.9 +
      Math.abs(enemy.y - lane.y) * 0.45;

    if (score < bestScore) {
      bestScore = score;
      bestPlan = {
        blocker,
        laneMode: lane.mode,
        nearPoint,
        farPoint,
      };
    }
  }

  return bestPlan;
}

function getFlyingMovementIntent(desiredVelocityX, desiredVelocityY) {
  if (Math.abs(desiredVelocityX) > 8) {
    return Math.sign(desiredVelocityX);
  }
  if (Math.abs(desiredVelocityY) > 8) {
    return desiredVelocityY < 0 ? -1 : 1;
  }
  return 0;
}

function updateEnemyProgressTracker(enemy, moveIntent, nowSec) {
  if (moveIntent === 0) {
    enemy.last_progress_x = enemy.x;
    enemy.last_progress_y = enemy.y;
    enemy.last_progress_at = nowSec;
    return;
  }

  const movedFarEnough =
    Math.abs(enemy.x - enemy.last_progress_x) >= 14 ||
    Math.abs(enemy.y - enemy.last_progress_y) >= 20;

  if (movedFarEnough || !Number.isFinite(enemy.last_progress_at)) {
    enemy.last_progress_x = enemy.x;
    enemy.last_progress_y = enemy.y;
    enemy.last_progress_at = nowSec;
  }
}

function getEnemyStuckDuration(enemy, moveIntent, nowSec) {
  if (moveIntent === 0 || !Number.isFinite(enemy.last_progress_at)) {
    return 0;
  }
  return Math.max(0, nowSec - enemy.last_progress_at);
}

function getNavigationProfile(definition) {
  const jumpForce = Math.max(definition.behavior.jumpForce, Math.abs(JUMP_FORCE));
  const moveSpeed = Math.max(60, definition.behavior.moveSpeed);
  const singleJumpHeight = Math.max(92, jumpForce * 0.16);
  const doubleJumpHeight = Math.max(singleJumpHeight * 2.05, singleJumpHeight + 104);
  const horizontalReach = Math.max(180, moveSpeed * 1.9);
  const dropHeight = Math.max(240, doubleJumpHeight + 64);

  return {
    key: `${Math.round(jumpForce)}:${Math.round(moveSpeed)}`,
    jumpForce,
    singleJumpHeight,
    doubleJumpHeight,
    horizontalReach,
    dropHeight,
  };
}

function getPlatformNode(state, platform) {
  return state.platformNavigation?.byPlatform?.get(platform) ?? null;
}

function getHorizontalGapBetweenNodes(fromNode, toNode) {
  if (fromNode.rightX < toNode.leftX) {
    return toNode.leftX - fromNode.rightX;
  }
  if (toNode.rightX < fromNode.leftX) {
    return fromNode.leftX - toNode.rightX;
  }
  return 0;
}

function canTraversePlatformGap(fromNode, toNode, profile) {
  if (!fromNode || !toNode || fromNode.id === toNode.id) {
    return false;
  }

  const rise = fromNode.topY - toNode.topY;
  const drop = toNode.topY - fromNode.topY;
  const gapX = getHorizontalGapBetweenNodes(fromNode, toNode);
  const landingBonus = Math.min(88, toNode.platform.w * 0.55);

  if (rise > 0) {
    if (rise > profile.doubleJumpHeight) {
      return false;
    }

    const reachScale = clamp(1 - rise / (profile.doubleJumpHeight * 1.28), 0.4, 1);
    return gapX <= profile.horizontalReach * reachScale + landingBonus;
  }

  if (drop > profile.dropHeight) {
    return false;
  }

  if (drop <= 28) {
    return gapX <= profile.horizontalReach + landingBonus;
  }

  return gapX <= profile.horizontalReach * 1.12 + landingBonus;
}

function getTraversalCost(fromNode, toNode, definition) {
  const profile = getNavigationProfile(definition);
  const gapX = getHorizontalGapBetweenNodes(fromNode, toNode);
  const rise = Math.max(0, fromNode.topY - toNode.topY);
  const drop = Math.max(0, toNode.topY - fromNode.topY);
  const launchX = getLaunchXForTransition(
    { x: fromNode.centerX },
    { width: Math.max(24, Math.min(96, fromNode.platform.w * 0.32)) },
    fromNode,
    toNode
  );
  const walkToLaunch = Math.abs(fromNode.centerX - launchX);
  const launchPenalty = rise > profile.singleJumpHeight * 0.88 ? 95 : 0;

  return (
    walkToLaunch * 0.75 +
    gapX * 1.35 +
    rise * 2.4 +
    drop * 0.42 +
    launchPenalty +
    24
  );
}

function getRouteHeuristic(node, targetNode) {
  return (
    Math.abs(node.centerX - targetNode.centerX) * 0.3 +
    Math.abs(node.topY - targetNode.topY) * 1.6
  );
}

function hasRaisedTerrainBetween(state, fromPlatform, toPlatform) {
  if (!fromPlatform || !toPlatform || fromPlatform === toPlatform || !Array.isArray(state.platforms)) {
    return false;
  }

  const minX = Math.min(fromPlatform.x + fromPlatform.w / 2, toPlatform.x + toPlatform.w / 2);
  const maxX = Math.max(fromPlatform.x + fromPlatform.w / 2, toPlatform.x + toPlatform.w / 2);
  const supportTopY = Math.min(fromPlatform.y, toPlatform.y);

  return state.platforms.some((platform) => {
    if (platform === fromPlatform || platform === toPlatform) {
      return false;
    }

    const overlapsSpan = platform.x < maxX - 6 && platform.x + platform.w > minX + 6;
    if (!overlapsSpan) {
      return false;
    }

    return platform.y < supportTopY - 14;
  });
}

function getReachablePlatformNeighbors(state, definition, fromNode) {
  const navigation = state.platformNavigation;
  if (!navigation || !fromNode) {
    return [];
  }

  const profile = getNavigationProfile(definition);
  let profileCache = navigation.adjacencyCache.get(profile.key);
  if (!profileCache) {
    profileCache = new Map();
    navigation.adjacencyCache.set(profile.key, profileCache);
  }

  const cached = profileCache.get(fromNode.id);
  if (cached) {
    return cached;
  }

  const neighbors = navigation.nodes
    .filter((toNode) => canTraversePlatformGap(fromNode, toNode, profile))
    .sort((a, b) => {
      const dy = Math.abs(a.topY - fromNode.topY) - Math.abs(b.topY - fromNode.topY);
      if (dy !== 0) {
        return dy;
      }
      return Math.abs(a.centerX - fromNode.centerX) - Math.abs(b.centerX - fromNode.centerX);
    });

  profileCache.set(fromNode.id, neighbors);
  return neighbors;
}

function findPlatformRoute(state, definition, fromPlatform, toPlatform) {
  const navigation = state.platformNavigation;
  if (!navigation || !fromPlatform || !toPlatform) {
    return null;
  }

  const startNode = getPlatformNode(state, fromPlatform);
  const targetNode = getPlatformNode(state, toPlatform);
  if (!startNode || !targetNode) {
    return null;
  }
  if (startNode.id === targetNode.id) {
    return [startNode];
  }

  if (!(navigation.routeCache instanceof Map)) {
    navigation.routeCache = new Map();
  }
  const profile = getNavigationProfile(definition);
  const routeCacheKey = `${profile.key}:${startNode.id}:${targetNode.id}`;
  if (navigation.routeCache.has(routeCacheKey)) {
    return navigation.routeCache.get(routeCacheKey);
  }

  const open = [startNode];
  const openIds = new Set([startNode.id]);
  const closed = new Set();
  const parentById = new Map();
  const gScore = new Map([[startNode.id, 0]]);
  const fScore = new Map([[startNode.id, getRouteHeuristic(startNode, targetNode)]]);
  let foundNode = null;

  while (open.length > 0 && closed.size <= 600) {
    open.sort((a, b) => (fScore.get(a.id) ?? Number.POSITIVE_INFINITY) - (fScore.get(b.id) ?? Number.POSITIVE_INFINITY));
    const currentNode = open.shift();
    if (!currentNode) {
      break;
    }
    openIds.delete(currentNode.id);

    if (currentNode.id === targetNode.id) {
      foundNode = currentNode;
      break;
    }

    closed.add(currentNode.id);

    const neighbors = getReachablePlatformNeighbors(state, definition, currentNode);
    for (const neighbor of neighbors) {
      if (closed.has(neighbor.id)) {
        continue;
      }

      const tentativeG =
        (gScore.get(currentNode.id) ?? Number.POSITIVE_INFINITY) +
        getTraversalCost(currentNode, neighbor, definition);

      if (tentativeG >= (gScore.get(neighbor.id) ?? Number.POSITIVE_INFINITY)) {
        continue;
      }

      parentById.set(neighbor.id, currentNode.id);
      gScore.set(neighbor.id, tentativeG);
      fScore.set(neighbor.id, tentativeG + getRouteHeuristic(neighbor, targetNode));

      if (!openIds.has(neighbor.id)) {
        open.push(neighbor);
        openIds.add(neighbor.id);
      }
    }
  }

  if (!foundNode) {
    navigation.routeCache.set(routeCacheKey, null);
    return null;
  }

  const path = [foundNode];
  let currentId = foundNode.id;
  while (parentById.has(currentId)) {
    const parentId = parentById.get(currentId);
    const parentNode = navigation.nodes[parentId];
    path.push(parentNode);
    currentId = parentId;
  }

  const resolvedPath = path.reverse();
  navigation.routeCache.set(routeCacheKey, resolvedPath);
  return resolvedPath;
}

function getLaunchXForTransition(enemy, enemyHitbox, fromNode, toNode) {
  const edgePadding = Math.max(enemyHitbox.width * 0.5, 18);
  const targetIsAbove = toNode.topY < fromNode.topY - 4;
  const targetIsBelow = toNode.topY > fromNode.topY + 4;
  const horizontalOverlapLeft = Math.max(fromNode.leftX, toNode.leftX);
  const horizontalOverlapRight = Math.min(fromNode.rightX, toNode.rightX);
  const hasHorizontalOverlap = horizontalOverlapRight - horizontalOverlapLeft > edgePadding * 1.2;

  if (toNode.leftX > fromNode.rightX) {
    return fromNode.rightX - edgePadding;
  }
  if (toNode.rightX < fromNode.leftX) {
    return fromNode.leftX + edgePadding;
  }

  if (targetIsAbove && hasHorizontalOverlap) {
    const leftExitX = fromNode.leftX + edgePadding;
    const rightExitX = fromNode.rightX - edgePadding;
    const leftTargetGap = Math.abs(toNode.centerX - leftExitX);
    const rightTargetGap = Math.abs(toNode.centerX - rightExitX);
    return leftTargetGap <= rightTargetGap ? leftExitX : rightExitX;
  }

  if (targetIsBelow && hasHorizontalOverlap) {
    const dropCommit = Math.max(enemyHitbox.width * 0.42, 16);
    const leftDropX = fromNode.leftX - dropCommit;
    const rightDropX = fromNode.rightX + dropCommit;
    const leftTargetGap = Math.abs(toNode.centerX - leftDropX);
    const rightTargetGap = Math.abs(toNode.centerX - rightDropX);
    return leftTargetGap <= rightTargetGap ? leftDropX : rightDropX;
  }

  return clamp(
    toNode.centerX,
    fromNode.leftX + edgePadding,
    fromNode.rightX - edgePadding
  );
}

function doesRouteTransitionNeedJump(fromNode, toNode) {
  if (!fromNode || !toNode) {
    return false;
  }

  const rise = fromNode.topY - toNode.topY;
  const gapX = getHorizontalGapBetweenNodes(fromNode, toNode);
  if (rise > 18) {
    return true;
  }
  return gapX > 18;
}

function getRouteNavigationPlan(state, enemy, definition, targetPlayer, enemySupport, playerSupport, playerHitbox) {
  if (!enemySupport || !playerSupport) {
    return null;
  }

  const route = findPlatformRoute(state, definition, enemySupport, playerSupport);
  if (!route || route.length <= 1) {
    return null;
  }

  const enemyHitbox = getEnemyHitboxForPosition(definition, enemy.x, enemy.y);
  const currentNode = route[0];
  const nextNode = route[1];
  const launchX = getLaunchXForTransition(enemy, enemyHitbox, currentNode, nextNode);
  const transitionNeedsJump = doesRouteTransitionNeedJump(currentNode, nextNode);
  const targetX = clamp(
    launchX,
    state.mapBounds.min_x + enemyHitbox.width / 2,
    state.mapBounds.max_x - enemyHitbox.width / 2
  );
  const climbHeight = currentNode.topY - nextNode.topY;
  const profile = getNavigationProfile(definition);

  return {
    targetX,
    targetTopY: nextNode.topY,
    jumpNow: transitionNeedsJump && Math.abs(enemy.x - targetX) <= Math.max(20, definition.behavior.moveSpeed * 0.18),
    playerIsAbove: playerHitbox.y + playerHitbox.height < enemyHitbox.y + enemyHitbox.height - 24,
    routeLength: route.length,
    pursuingPlatformFirst: route.length > 1,
    needsDoubleJump: transitionNeedsJump && climbHeight > profile.singleJumpHeight * 0.9,
    requiresJump: transitionNeedsJump,
  };
}

function choosePreferredRoutePlan(state, enemy, definition, targetPlayer, enemySupport, playerSupport, playerHitbox) {
  if (!enemySupport || !playerSupport || !playerHitbox) {
    return null;
  }

  return getRouteNavigationPlan(
    state,
    enemy,
    definition,
    targetPlayer,
    enemySupport,
    playerSupport,
    playerHitbox
  );
}

function getChaseNavigationPlan(state, enemy, definition, targetPlayer) {
  if (!targetPlayer) {
    return null;
  }

  const enemyHitbox = getEnemyHitboxForPosition(definition, enemy.x, enemy.y);
  if (!enemyHitbox) {
    return null;
  }

  const playerHitbox = getPlayerHitbox(targetPlayer);
  const playerSupport = getSupportPlatformForHitbox(state, playerHitbox);
  const enemySupport = getEnemySupportPlatform(state, enemy, definition);
  const enemyFeetY = enemyHitbox.y + enemyHitbox.height;
  const playerFeetY = playerHitbox.y + playerHitbox.height;
  const playerIsAbove = playerFeetY < enemyFeetY - 34;
  const sameSupportLevel =
    playerSupport &&
    enemySupport &&
    Math.abs(playerSupport.y - enemySupport.y) <= 20;
  const sameGroundBand = Math.abs(playerFeetY - enemyFeetY) <= 52;
  const raisedTerrainBetween =
    playerSupport &&
    enemySupport &&
    hasRaisedTerrainBetween(state, enemySupport, playerSupport);
  const profile = getNavigationProfile(definition);
  const mapMinX = state.mapBounds.min_x + enemyHitbox.width / 2;
  const mapMaxX = state.mapBounds.max_x - enemyHitbox.width / 2;
  const horizontalGap = Math.abs(targetPlayer.x - enemy.x);

  if (!playerIsAbove && (!playerSupport || !enemySupport || (sameSupportLevel && !raisedTerrainBetween) || sameGroundBand)) {
    return {
      targetX: clamp(targetPlayer.x, mapMinX, mapMaxX),
      targetTopY: playerSupport ? playerSupport.y : playerHitbox.y,
      jumpNow: false,
      playerIsAbove: false,
      routeLength: 0,
      pursuingPlatformFirst: false,
      needsDoubleJump: false,
      preferGroundChase: true,
      requiresJump: false,
    };
  }

  let targetX = clamp(targetPlayer.x, mapMinX, mapMaxX);
  let targetTopY = playerSupport ? playerSupport.y : playerHitbox.y;
  let jumpNow = false;
  let needsDoubleJump = false;
  let pursuingPlatformFirst = false;

  if (playerIsAbove) {
    pursuingPlatformFirst = Boolean(playerSupport);
    needsDoubleJump = enemyFeetY - targetTopY > profile.singleJumpHeight * 0.92;

    if (playerSupport) {
      const edgePadding = enemyHitbox.width * 0.5 + 18;
      const leftLaunchX = clamp(playerSupport.x - edgePadding, mapMinX, mapMaxX);
      const rightLaunchX = clamp(playerSupport.x + playerSupport.w + edgePadding, mapMinX, mapMaxX);
      const underPlatform =
        enemy.x > playerSupport.x + 10 &&
        enemy.x < playerSupport.x + playerSupport.w - 10 &&
        enemyFeetY >= playerSupport.y - 8;

      if (underPlatform || !enemySupport || (enemySupport.y > playerSupport.y + 12)) {
        targetX = Math.abs(enemy.x - leftLaunchX) <= Math.abs(enemy.x - rightLaunchX)
          ? leftLaunchX
          : rightLaunchX;
      } else {
        targetX = clamp(targetPlayer.x, playerSupport.x + 18, playerSupport.x + playerSupport.w - 18);
      }
    }

    jumpNow = Math.abs(targetX - enemy.x) <= Math.max(24, definition.behavior.moveSpeed * 0.22);
  } else if (playerSupport && enemySupport && raisedTerrainBetween) {
    pursuingPlatformFirst = true;
    targetX = clamp(targetPlayer.x, mapMinX, mapMaxX);
  }

  return {
    targetX,
    targetTopY,
    jumpNow,
    playerIsAbove,
    routeLength: pursuingPlatformFirst ? 1 : 0,
    pursuingPlatformFirst,
    needsDoubleJump,
    preferGroundChase: !playerIsAbove && !raisedTerrainBetween,
    requiresJump: playerIsAbove && (jumpNow || horizontalGap <= Math.max(56, definition.behavior.moveSpeed * 0.34)),
  };
}

function setBrainState(enemy, nextState, nowSec) {
  if (enemy.brain_state === nextState) {
    return;
  }

  enemy.brain_state = nextState;
  enemy.state_started_at = nowSec;
}

function buildEnemyInstance(spawn, definition) {
  const nowSec = Date.now() / 1000;
  const level = Math.max(1, Math.round(Number(spawn.level) || 1));
  const runtimeDefinition = buildScaledEnemyDefinition(definition, level);
  const startsFlying = isFlyingEnemy(definition);
  const startsAsPerchedGargoyle = isGargoyleEnemy(definition) && Math.random() < 0.55;
  return {
    id: spawn.id,
    spawn_id: spawn.id,
    type: spawn.type,
    x: spawn.x,
    y: spawn.y,
    spawn_x: spawn.x,
    spawn_y: spawn.y,
    vx: 0,
    vy: 0,
    knockback_vx: 0,
    on_ground: false,
    jumps_remaining: 2,
    direction: 'right',
    action: 'idle',
    brain_state: 'idle',
    state_started_at: nowSec,
    target_sid: null,
    aggro_until: 0,
    wander_target_x: spawn.x,
    next_decision_at: nowSec + Math.random() * 1.4,
    last_jump_at: 0,
    last_progress_x: spawn.x,
    last_progress_y: spawn.y,
    last_progress_at: nowSec,
    jump_start_y: spawn.y,
    jump_target_top_y: 0,
    jump_requires_double: false,
    jump_launch_vx: 0,
    attack_cooldown_until: 0,
    prepare_until: 0,
    lunge_until: 0,
    recover_until: 0,
    attack_release_at: 0,
    attack_shot_fired: false,
    attack_hit_victims: [],
    level,
    runtime_definition: runtimeDefinition,
    health: runtimeDefinition.stats.maxHealth,
    max_health: runtimeDefinition.stats.maxHealth,
    alive: true,
    death_time: 0,
    despawn_at: 0,
    respawn_at: 0,
    spawn_time_ms: Date.now(),
    spawn_protected_until_ms: Date.now() + ENEMY_SPAWN_GRACE_MS,
    nav_cache_key: '',
    nav_cache_until: 0,
    nav_cache_plan: null,
    preferred_hover_offset_x: (Math.random() < 0.5 ? -1 : 1) * (110 + Math.random() * 90),
    preferred_hover_y: spawn.y - definition.behavior.hoverHeight,
    attack_altitude_bias: -definition.behavior.hoverHeight,
    next_altitude_swap_at: nowSec + 0.8 + Math.random() * 0.9,
    movement_mode: startsFlying ? 'flying' : 'ground',
    attached_sid: null,
    attached_offset_x: 0,
    attached_offset_y: SLIME_ATTACH_OFFSET_Y,
    surface_stick_until: 0,
    gargoyle_mode: startsAsPerchedGargoyle ? 'perch' : (isGargoyleEnemy(definition) ? 'swoop' : null),
    gargoyle_mode_until: nowSec + 2.4 + Math.random() * 2.6,
    gargoyle_perch_opacity: startsAsPerchedGargoyle ? GARGOYLE_PERCH_OPACITY : GARGOYLE_ACTIVE_OPACITY,
    render_opacity: startsAsPerchedGargoyle ? GARGOYLE_PERCH_OPACITY : (isGhostEnemy(definition) ? GHOST_PASSIVE_OPACITY : GARGOYLE_ACTIVE_OPACITY),
    stealth_broken: false,
    spawned_for_sid: typeof spawn.spawned_for_sid === 'string' ? spawn.spawned_for_sid : null,
    attack_repeat_next_at: 0,
    environment_attack_cooldown_until: 0,
  };
}

function triggerStrikerEnvironmentAttack(state, enemy, targetPlayer, nowSec) {
  if (!targetPlayer || nowSec < (enemy.environment_attack_cooldown_until || 0)) {
    return false;
  }

  const prevDistance = Math.hypot(targetPlayer.x - enemy.x, targetPlayer.y - enemy.y);
  const stepX = clamp(targetPlayer.x - enemy.x, -STRIKER_SQUEEZE_STEP_X, STRIKER_SQUEEZE_STEP_X);
  const stepY = clamp(targetPlayer.y - enemy.y, -STRIKER_SQUEEZE_STEP_Y, STRIKER_SQUEEZE_STEP_Y);
  const nextX = clamp(enemy.x + stepX, state.mapBounds.min_x + 24, state.mapBounds.max_x - 24);
  const nextY = clamp(enemy.y + stepY, state.mapBounds.min_y + 24, state.mapBounds.max_y - 24);
  const nextDistance = Math.hypot(targetPlayer.x - nextX, targetPlayer.y - nextY);

  enemy.environment_attack_cooldown_until = nowSec + STRIKER_ENVIRONMENT_ATTACK_COOLDOWN_SECONDS;
  enemy.action = 'attack';
  enemy.attack_repeat_next_at = nowSec + 0.16;

  if (nextDistance + 6 >= prevDistance) {
    return false;
  }

  enemy.x = nextX;
  enemy.y = nextY;
  enemy.last_progress_x = enemy.x;
  enemy.last_progress_y = enemy.y;
  enemy.last_progress_at = nowSec;
  return true;
}

function emitSlimeSplatter(state, io, x, y, targetSid = null, radius = SLIME_SPLAT_RADIUS) {
  if (!state || !io || !Number.isFinite(x) || !Number.isFinite(y)) {
    return;
  }

  emitToNearbyPlayers({
    io,
    state,
    x,
    y,
    radiusX: ENEMY_EFFECT_RADIUS_X,
    radiusY: ENEMY_EFFECT_RADIUS_Y,
    event: 'slime_splatter',
    payload: {
      x,
      y,
      radius,
      target_sid: typeof targetSid === 'string' ? targetSid : null,
    },
    includeSids: typeof targetSid === 'string' ? [targetSid] : [],
  });
}

function emitStrikerGroundImpact(state, io, enemy, impactSpeed = 0) {
  if (!state || !io || !enemy) {
    return;
  }

  emitToNearbyPlayers({
    io,
    state,
    x: enemy.x,
    y: enemy.y,
    radiusX: ENEMY_EFFECT_RADIUS_X,
    radiusY: ENEMY_EFFECT_RADIUS_Y,
    event: 'striker_ground_impact',
    payload: {
      enemy_id: enemy.id,
      x: enemy.x,
      y: enemy.y,
      impact_speed: Math.round(Math.abs(Number(impactSpeed) || 0)),
      at_ms: Date.now(),
    },
  });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function shuffleArray(items) {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const current = copy[index];
    copy[index] = copy[swapIndex];
    copy[swapIndex] = current;
  }
  return copy;
}

function buildCandidatePoints(min, max, fallback) {
  if (!(max > min)) {
    return [fallback];
  }

  const values = [];
  const span = max - min;
  const steps = 7;
  for (let index = 0; index < steps; index += 1) {
    const ratio = steps === 1 ? 0.5 : index / (steps - 1);
    values.push(min + span * ratio);
  }

  for (let index = 0; index < 5; index += 1) {
    values.push(min + Math.random() * span);
  }

  return shuffleArray(values);
}

function getEnemyCenterFromHitboxPosition(definition, hitboxX, hitboxY) {
  const shape = getEnemyShape(definition);
  return {
    x: hitboxX - shape.localX,
    y: hitboxY - shape.localY,
  };
}

function getMapTileArea(state) {
  const width = Math.max(0, (state.mapBounds?.max_x ?? 0) - (state.mapBounds?.min_x ?? 0));
  const height = Math.max(0, (state.mapBounds?.max_y ?? 0) - (state.mapBounds?.min_y ?? 0));
  return (width * height) / (32 * 32);
}

function canFitEnemyWithinBounds(state, definition, position) {
  const hitbox = getEnemyHitboxForPosition(definition, position.x, position.y);
  if (!hitbox || !state.mapBounds) {
    return false;
  }

  return (
    hitbox.x >= state.mapBounds.min_x + ENEMY_SPAWN_EDGE_PADDING_X &&
    hitbox.x + hitbox.width <= state.mapBounds.max_x - ENEMY_SPAWN_EDGE_PADDING_X &&
    hitbox.y >= state.mapBounds.min_y + ENEMY_SPAWN_EDGE_PADDING_Y &&
    hitbox.y + hitbox.height <= state.mapBounds.max_y
  );
}

function overlapsOtherEnemySpawn(definition, position, occupiedSpawns) {
  const hitbox = getEnemyHitboxForPosition(definition, position.x, position.y);
  if (!hitbox) {
    return true;
  }

  return occupiedSpawns.some((spawn) => {
    const otherHitbox = getEnemyHitboxForPosition(spawn.definition, spawn.x, spawn.y);
    if (!otherHitbox) {
      return false;
    }

    const paddingX = 24;
    const paddingY = 20;
    return (
      hitbox.x < otherHitbox.x + otherHitbox.width + paddingX &&
      hitbox.x + hitbox.width + paddingX > otherHitbox.x &&
      hitbox.y < otherHitbox.y + otherHitbox.height + paddingY &&
      hitbox.y + hitbox.height + paddingY > otherHitbox.y
    );
  });
}

function collidesWithPlatforms(state, definition, position) {
  const hitbox = getEnemyHitboxForPosition(definition, position.x, position.y);
  if (!hitbox) {
    return true;
  }

  return state.platforms.some((platform) => (
    hitbox.x < platform.x + platform.w &&
    hitbox.x + hitbox.width > platform.x &&
    hitbox.y < platform.y + platform.h &&
    hitbox.y + hitbox.height > platform.y
  ));
}

function hasOpenAirAbove(state, hitbox, requiredHeight) {
  const airBox = {
    x: hitbox.x,
    y: hitbox.y - requiredHeight,
    width: hitbox.width,
    height: requiredHeight,
  };

  if (airBox.y < (state.mapBounds?.min_y ?? 0) + ENEMY_SPAWN_EDGE_PADDING_Y) {
    return false;
  }

  return !state.platforms.some((platform) => (
    airBox.x < platform.x + platform.w &&
    airBox.x + airBox.width > platform.x &&
    airBox.y < platform.y + platform.h &&
    airBox.y + airBox.height > platform.y
  ));
}

function isEnemySpawnPlacementValid(state, definition, position, occupiedSpawns, options = {}) {
  if (!canFitEnemyWithinBounds(state, definition, position)) {
    return false;
  }

  if (collidesWithPlatforms(state, definition, position)) {
    return false;
  }

  if (overlapsOtherEnemySpawn(definition, position, occupiedSpawns)) {
    return false;
  }

  const hitbox = getEnemyHitboxForPosition(definition, position.x, position.y);
  if (!hitbox) {
    return false;
  }

  if (options.requiresSupport) {
    const supported = state.platforms.some((platform) => (
      hitbox.x < platform.x + platform.w &&
      hitbox.x + hitbox.width > platform.x &&
      Math.abs(hitbox.y + hitbox.height - platform.y) <= 2
    ));

    if (!supported) {
      return false;
    }
  }

  if (options.requiredHeadroom && !hasOpenAirAbove(state, hitbox, options.requiredHeadroom)) {
    return false;
  }

  return true;
}

function getEnemyTargetCount(state, enemyType, worldThreatLevel = 1) {
  if (worldThreatLevel < getEnemyTypeUnlockLevel(enemyType)) {
    return 0;
  }

  const tileArea = getMapTileArea(state);
  const platformCount = Array.isArray(state.platforms) ? state.platforms.length : 0;
  const widePlatforms = Array.isArray(state.platforms)
    ? state.platforms.filter((platform) => platform.w >= BAT_MIN_PLATFORM_WIDTH).length
    : 0;
  const progressionBonus = Math.max(0, worldThreatLevel - 1);

  if (enemyType === 'bat') {
    return clamp(Math.round(tileArea / 260) + Math.floor(widePlatforms / 10) + Math.floor(Math.max(0, progressionBonus - 2) / 5), 1, 8);
  }

  if (enemyType === 'spider') {
    return clamp(Math.round(tileArea / 148) + Math.floor(platformCount / 12) + Math.floor(progressionBonus / 3), 3, 16);
  }

  if (enemyType === 'slime') {
    return clamp(Math.round(tileArea / 240) + Math.floor(platformCount / 18) + Math.floor(progressionBonus / 5), 1, 9);
  }

  if (enemyType === 'gargoyle') {
    return clamp(Math.round(tileArea / 420) + Math.floor(platformCount / 28) + Math.floor(Math.max(0, progressionBonus - 7) / 8), 1, 5);
  }

  if (enemyType === 'striker') {
    return clamp(Math.round(tileArea / 620) + Math.floor(widePlatforms / 18) + Math.floor(Math.max(0, progressionBonus - 11) / 12), 1, 3);
  }

  return clamp(Math.round(tileArea / 150) + Math.floor(progressionBonus / 4), 1, 12);
}

function getDynamicSpawnAnchor(state) {
  let anchorPlayer = null;
  let anchorSid = null;
  let anchorThreat = -1;
  for (const [sid, player] of state.players.entries()) {
    if (!player || player.is_dying || !player.is_ready) {
      continue;
    }
    const threat = getPlayerLevel(player) + Math.floor(Math.max(0, Number(player.soul_count) || 0) / 14);
    if (threat > anchorThreat) {
      anchorThreat = threat;
      anchorPlayer = player;
      anchorSid = sid;
    }
  }
  return anchorPlayer ? { sid: anchorSid, player: anchorPlayer } : null;
}

function sortPlatformsForSpawn(platforms, anchorPlayer) {
  if (!anchorPlayer) {
    return platforms;
  }

  return platforms.slice().sort((a, b) => {
    const aCenterX = a.x + a.w / 2;
    const bCenterX = b.x + b.w / 2;
    const aForward = anchorPlayer.direction === 'left' ? aCenterX < anchorPlayer.x : aCenterX > anchorPlayer.x;
    const bForward = anchorPlayer.direction === 'left' ? bCenterX < anchorPlayer.x : bCenterX > anchorPlayer.x;
    if (aForward !== bForward) {
      return aForward ? -1 : 1;
    }
    const aDistance = Math.abs(aCenterX - anchorPlayer.x) + Math.abs(a.y - anchorPlayer.y) * 0.6;
    const bDistance = Math.abs(bCenterX - anchorPlayer.x) + Math.abs(b.y - anchorPlayer.y) * 0.6;
    return aDistance - bDistance;
  });
}

function pickGroundEnemySpawn(state, definition, occupiedSpawns, options = {}) {
  const shape = getEnemyShape(definition);
  const platforms = sortPlatformsForSpawn(shuffleArray(Array.isArray(state.platforms) ? state.platforms : []).filter((platform) => (
    platform.w >= shape.width + ENEMY_PLATFORM_INSET * 2
  )), options.anchorPlayer);

  for (const platform of platforms) {
    const minHitboxX = platform.x + ENEMY_PLATFORM_INSET;
    const maxHitboxX = platform.x + platform.w - shape.width - ENEMY_PLATFORM_INSET;
    const candidateHitboxXs = buildCandidatePoints(
      minHitboxX,
      maxHitboxX,
      platform.x + (platform.w - shape.width) / 2
    );

    for (const hitboxX of candidateHitboxXs) {
      const position = getEnemyCenterFromHitboxPosition(definition, hitboxX, platform.y - shape.height);
      if (isEnemySpawnPlacementValid(state, definition, position, occupiedSpawns, { requiresSupport: true })) {
        return position;
      }
    }
  }

  return null;
}

function pickFlyingEnemySpawn(state, definition, occupiedSpawns, options = {}) {
  const shape = getEnemyShape(definition);
  const platforms = sortPlatformsForSpawn(shuffleArray(Array.isArray(state.platforms) ? state.platforms : []).filter((platform) => (
    platform.w >= Math.max(BAT_MIN_PLATFORM_WIDTH, shape.width + ENEMY_PLATFORM_INSET * 2)
  )), options.anchorPlayer);

  for (const platform of platforms) {
    const minHitboxX = platform.x + ENEMY_PLATFORM_INSET;
    const maxHitboxX = platform.x + platform.w - shape.width - ENEMY_PLATFORM_INSET;
    const candidateHitboxXs = buildCandidatePoints(minHitboxX, maxHitboxX, platform.x + (platform.w - shape.width) / 2);
    const hoverOffset = Math.max(BAT_REQUIRED_HEADROOM, Math.round(definition.behavior.hoverHeight * 0.9));
    const hitboxY = platform.y - hoverOffset - shape.height;

    for (const hitboxX of candidateHitboxXs) {
      const position = getEnemyCenterFromHitboxPosition(definition, hitboxX, hitboxY);
      if (isEnemySpawnPlacementValid(state, definition, position, occupiedSpawns, { requiredHeadroom: BAT_REQUIRED_HEADROOM })) {
        return position;
      }
    }
  }

  return null;
}

function pickEnemySpawnPosition(state, definition, occupiedSpawns, options = {}) {
  if (isFlyingEnemy(definition)) {
    return pickFlyingEnemySpawn(state, definition, occupiedSpawns, options);
  }
  return pickGroundEnemySpawn(state, definition, occupiedSpawns, options);
}

function createProceduralEnemySpawns(state) {
  const enemyTypes = Object.keys(state.enemyDefinitions ?? {});
  const nextSpawns = [];
  const occupiedSpawns = [];
  const worldThreatLevel = getWorldThreatLevel(state);
  const anchor = getDynamicSpawnAnchor(state);
  const anchorPlayer = anchor?.player ?? null;

  for (const enemyType of enemyTypes) {
    const definition = getEnemyDefinition(state, enemyType);
    if (!definition) {
      continue;
    }

    const minSoulsRequired = definition.stats?.minSoulsRequired ?? 0;
    if (minSoulsRequired > 0) {
      let hasPlayerWithEnoughSouls = false;
      for (const player of state.players.values()) {
        if (!player || player.is_dying) {
          continue;
        }
        const soulCount = Math.max(0, Math.round(Number(player.soul_count) || 0));
        if (soulCount >= minSoulsRequired) {
          hasPlayerWithEnoughSouls = true;
          break;
        }
      }
      if (!hasPlayerWithEnoughSouls) {
        continue;
      }
    }

    const targetCount = getEnemyTargetCount(state, enemyType, worldThreatLevel);
    const enemyLevel = rollEnemySpawnLevel(worldThreatLevel, enemyType);
    if (targetCount <= 0 || enemyLevel <= 0) {
      continue;
    }
    for (let index = 0; index < targetCount; index += 1) {
      const position = pickEnemySpawnPosition(state, definition, occupiedSpawns, { anchorPlayer });
      if (!position) {
        break;
      }

      const spawn = {
        id: `${enemyType}_${index}_${Math.random().toString(16).slice(2, 8)}`,
        type: enemyType,
        level: enemyLevel,
        x: position.x,
        y: position.y,
      };
      nextSpawns.push(spawn);
      occupiedSpawns.push({ ...position, definition });
    }
  }

  return nextSpawns;
}

function resetEnemiesForState(input) {
  ensureEnemyDirector(input.state);
  const nextEnemies = new Map();
  const enemySpawns = createProceduralEnemySpawns(input.state);
  input.state.enemySpawns = enemySpawns;

  for (const spawn of enemySpawns) {
    const definition = getEnemyDefinition(input.state, spawn.type);
    if (!definition) {
      continue;
    }

    nextEnemies.set(spawn.id, buildEnemyInstance(spawn, definition));
  }

  input.state.enemies = nextEnemies;
}

function syncEnemyDirector(state, io) {
  const director = ensureEnemyDirector(state);
  const nowMs = Date.now();
  if (nowMs - director.lastSyncAtMs < ENEMY_DIRECTOR_SYNC_MS) {
    return;
  }

  director.lastSyncAtMs = nowMs;
  const worldThreatLevel = getWorldThreatLevel(state);
  director.lastThreatLevel = worldThreatLevel;

  const occupiedSpawns = [];
  const existingCountsByType = new Map();
  for (const enemy of state.enemies.values()) {
    if (!enemy) {
      continue;
    }
    existingCountsByType.set(enemy.type, (existingCountsByType.get(enemy.type) || 0) + 1);

    if (enemy.alive) {
      const definition = enemy.runtime_definition || getEnemyDefinition(state, enemy.type);
      if (!definition) {
        continue;
      }
      occupiedSpawns.push({ x: enemy.x, y: enemy.y, definition });
    }
  }

  const anchor = getDynamicSpawnAnchor(state);
  const anchorPlayer = anchor?.player ?? null;
  const spawnedByType = new Map();
  for (const enemyType of Object.keys(state.enemyDefinitions ?? {})) {
    const definition = getEnemyDefinition(state, enemyType);
    const targetCount = getEnemyTargetCount(state, enemyType, worldThreatLevel);
    const desiredLevel = getEnemyLevelForType(worldThreatLevel, enemyType);
    if (!definition || targetCount <= 0 || desiredLevel <= 0) {
      continue;
    }

    const minSoulsRequired = definition.stats?.minSoulsRequired ?? 0;
    if (minSoulsRequired > 0) {
      let hasPlayerWithEnoughSouls = false;
      for (const player of state.players.values()) {
        if (!player || player.is_dying) {
          continue;
        }
        const soulCount = Math.max(0, Math.round(Number(player.soul_count) || 0));
        if (soulCount >= minSoulsRequired) {
          hasPlayerWithEnoughSouls = true;
          break;
        }
      }
      if (!hasPlayerWithEnoughSouls) {
        continue;
      }
    }

    const existingCount = existingCountsByType.get(enemyType) || 0;
    for (let index = existingCount; index < targetCount; index += 1) {
      const position = pickEnemySpawnPosition(state, definition, occupiedSpawns, { anchorPlayer });
      if (!position) {
        break;
      }

      const spawn = {
        id: `${enemyType}_${Date.now().toString(16)}_${Math.random().toString(16).slice(2, 7)}`,
        type: enemyType,
        level: rollEnemySpawnLevel(worldThreatLevel, enemyType),
        x: position.x,
        y: position.y,
        spawned_for_sid: anchor?.sid ?? null,
      };
      const enemy = buildEnemyInstance(spawn, definition);
      state.enemies.set(enemy.id, enemy);
      state.enemySpawns.push(spawn);
      occupiedSpawns.push({ x: position.x, y: position.y, definition: enemy.runtime_definition || definition });
      existingCountsByType.set(enemyType, (existingCountsByType.get(enemyType) || 0) + 1);

      if (!spawnedByType.has(enemyType)) {
        spawnedByType.set(enemyType, {
          count: 0,
          x: position.x,
          y: position.y,
          anchorSid: anchor?.sid ?? null,
        });
      }
      const spawnInfo = spawnedByType.get(enemyType);
      spawnInfo.count += 1;
      spawnInfo.x = position.x;
      spawnInfo.y = position.y;
    }
  }

  for (const [enemyType, spawnInfo] of spawnedByType.entries()) {
    maybeBroadcastEnemyPressureAlert(state, io, enemyType, spawnInfo);
  }
}

function chooseTargetPlayer(state, enemy, definition, nowSec) {
  const currentTarget = enemy.target_sid ? state.players.get(enemy.target_sid) : null;
  if (currentTarget && !currentTarget.is_dying) {
    const dx = currentTarget.x - enemy.x;
    const dy = currentTarget.y - enemy.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= definition.behavior.leashRadius || nowSec <= enemy.aggro_until) {
      enemy.target_sid = enemy.target_sid;
      return currentTarget;
    }
  }

  let bestPlayer = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [sid, player] of state.players.entries()) {
    if (player.is_dying) {
      continue;
    }
    if (getPlayerLevel(player) <= SAFE_PLAYER_LEVEL_CAP) {
      continue;
    }

    const dx = player.x - enemy.x;
    const dy = player.y - enemy.y;
    const distance = Math.hypot(dx, dy);
    if (distance > definition.behavior.detectionRadius) {
      continue;
    }

    if (!hasLineOfSightToPlayer(state, enemy, player)) {
      continue;
    }

    if (distance < bestDistance) {
      bestDistance = distance;
      bestPlayer = { sid, player };
    }
  }

  if (bestPlayer) {
    enemy.aggro_until = nowSec + 4.5;
    enemy.target_sid = bestPlayer.sid;
    return bestPlayer.player;
  }

  if (nowSec <= enemy.aggro_until && currentTarget && !currentTarget.is_dying) {
    return currentTarget;
  }

  return null;
}

function pickWanderTarget(enemy, definition, nowSec) {
  const radius = definition.behavior.wanderRadius;
  const randomOffset = (Math.random() * 2 - 1) * radius;
  enemy.wander_target_x = enemy.spawn_x + randomOffset;
  enemy.next_decision_at = nowSec + 1.2 + Math.random() * 2.2;
}

function beginPrepare(enemy, targetPlayer, nowSec, definition) {
  setBrainState(enemy, 'prepare', nowSec);
  enemy.action = 'prepare';
  if (isGargoyleEnemy(definition)) {
    enemy.stealth_broken = true;
    enemy.render_opacity = GARGOYLE_ACTIVE_OPACITY;
  }
  enemy.prepare_until = nowSec + secondsFromMs(definition.behavior.telegraphDurationMs);
  enemy.attack_release_at = nowSec + secondsFromMs(definition.behavior.telegraphDurationMs * 0.68);
  enemy.attack_shot_fired = false;
  enemy.attack_hit_victims = [];
  enemy.vx = 0;
  enemy.jump_launch_vx = 0;
  enemy.knockback_vx = 0;
  if (isFlyingEnemy(definition)) {
    enemy.vy = 0;
  }
  if (targetPlayer) {
    enemy.direction = targetPlayer.x < enemy.x ? 'left' : 'right';
  }
}

function beginLunge(enemy, targetPlayer, nowSec, definition) {
  if (isStrikerEnemy(definition)) {
    const targetX = targetPlayer ? targetPlayer.x : enemy.x + (enemy.direction === 'left' ? -140 : 140);
    const targetY = targetPlayer ? targetPlayer.y : enemy.y + 180;
    const dx = targetX - enemy.x;
    const dy = targetY - enemy.y;
    const horizontalTravelSeconds = Math.max(0.26, secondsFromMs(definition.behavior.lungeDurationMs) * 0.72);
    const downwardBias = Math.max(420, definition.behavior.verticalMoveSpeed * 3.2);

    setBrainState(enemy, 'lunge', nowSec);
    enemy.action = 'attack';
    enemy.direction = dx < 0 ? 'left' : 'right';
    enemy.vx = clamp(dx / horizontalTravelSeconds, -definition.behavior.lungeSpeed, definition.behavior.lungeSpeed);
    enemy.vy = Math.max(downwardBias, dy / Math.max(0.18, horizontalTravelSeconds));
    enemy.jump_launch_vx = 0;
    enemy.knockback_vx = 0;
    enemy.on_ground = false;
    enemy.lunge_until = nowSec + secondsFromMs(definition.behavior.lungeDurationMs);
    enemy.attack_cooldown_until = nowSec + secondsFromMs(definition.behavior.attackCooldownMs);
    enemy.attack_hit_victims = [];
    enemy.striker_slam_started_at = nowSec;
    enemy.striker_slam_impacted_at = 0;
    enemy.striker_recover_until = 0;
    return;
  }

  if (usesProjectileAttackForEnemy(enemy, definition)) {
    setBrainState(enemy, 'lunge', nowSec);
    enemy.action = 'attack';
    enemy.vx = 0;
    enemy.vy = 0;
    enemy.jump_launch_vx = 0;
    enemy.knockback_vx = 0;
    enemy.lunge_until = nowSec + secondsFromMs(definition.behavior.lungeDurationMs);
    enemy.attack_cooldown_until = nowSec + secondsFromMs(definition.behavior.attackCooldownMs);
    enemy.attack_hit_victims = [];
    return;
  }

  const targetX = targetPlayer ? targetPlayer.x : enemy.x + (enemy.direction === 'left' ? -1 : 1) * 100;
  const targetY = targetPlayer ? targetPlayer.y : enemy.y - 40;
  const dx = targetX - enemy.x;
  const dy = targetY - enemy.y;
  const distance = Math.max(1, Math.hypot(dx, dy));
  const dirX = dx / distance;
  const dirY = dy / distance;

  setBrainState(enemy, 'lunge', nowSec);
  enemy.action = 'attack';
  enemy.direction = dirX < 0 ? 'left' : 'right';
  enemy.vx = dirX * definition.behavior.lungeSpeed;
  enemy.jump_launch_vx = 0;
  enemy.knockback_vx = 0;
  if (isGhostEnemy(definition)) {
    const lungeDuration = secondsFromMs(definition.behavior.lungeDurationMs);
    enemy.vy = dirY * (distance / Math.max(0.1, lungeDuration)) * 0.9;
  } else {
    enemy.vy = -definition.behavior.lungeLift + Math.min(0, dirY) * 180;
  }
  enemy.on_ground = false;
  enemy.lunge_until = nowSec + secondsFromMs(definition.behavior.lungeDurationMs);
  enemy.attack_cooldown_until = nowSec + secondsFromMs(
    isGargoyleEnemy(definition) && enemy.gargoyle_mode === 'swoop'
      ? definition.behavior.attackCooldownMs * clamp(2.35 - Math.max(0, (Number(enemy.level) || 1) - 1) * 0.08, 1.35, 2.35)
      : definition.behavior.attackCooldownMs
  );
  enemy.attack_hit_victims = [];
}

function randomizeGargoyleMode(enemy, nowSec, options = {}) {
  const preferredMode = options.preferredMode === 'perch' || options.preferredMode === 'swoop'
    ? options.preferredMode
    : null;
  const levelBoost = Math.max(0, (Number(enemy?.level) || 1) - 1);
  const perchChance = clamp(0.94 - levelBoost * 0.03, 0.56, 0.94);
  const nextMode = preferredMode || (Math.random() < perchChance ? 'perch' : 'swoop');
  enemy.gargoyle_mode = nextMode;
  enemy.gargoyle_perch_opacity = nextMode === 'perch' ? GARGOYLE_PERCH_OPACITY : GARGOYLE_ACTIVE_OPACITY;
  enemy.gargoyle_mode_until = nowSec + (
    nextMode === 'perch'
      ? Math.max(2.4, 6 - levelBoost * 0.28) + Math.random() * Math.max(1.3, 4.1 - levelBoost * 0.14)
      : Math.max(1.4, 1.9 - levelBoost * 0.04) + Math.random() * Math.max(0.8, 1.55 - levelBoost * 0.03)
  );
  if (nextMode === 'perch') {
    enemy.preferred_hover_offset_x = 0;
    enemy.attack_altitude_bias = 0;
  } else {
    enemy.preferred_hover_offset_x = (Math.random() < 0.5 ? -1 : 1) * (88 + Math.random() * 90);
    enemy.attack_altitude_bias = -Math.max(70, Math.min(140, Math.abs(enemy.attack_altitude_bias || 0) || 92));
  }
}

function updateGargoyleMode(state, enemy, definition, targetPlayer, nowSec) {
  if (!isGargoyleEnemy(definition)) {
    return;
  }

  if (!enemy.gargoyle_mode) {
    randomizeGargoyleMode(enemy, nowSec);
  }

  const distanceToTarget = targetPlayer
    ? Math.hypot(targetPlayer.x - enemy.x, targetPlayer.y - enemy.y)
    : Number.POSITIVE_INFINITY;

  if (targetPlayer) {
    if (
      enemy.gargoyle_mode === 'perch' &&
      distanceToTarget > definition.behavior.attackRange * 1.55 &&
      nowSec >= enemy.gargoyle_mode_until - 0.35
    ) {
      randomizeGargoyleMode(enemy, nowSec, { preferredMode: 'swoop' });
    } else if (
      enemy.gargoyle_mode === 'swoop' &&
      distanceToTarget <= definition.behavior.attackRange * 0.8 &&
      Math.abs(targetPlayer.y - enemy.y) <= definition.behavior.hoverVariance + 80 &&
      nowSec >= enemy.gargoyle_mode_until
    ) {
      randomizeGargoyleMode(enemy, nowSec, { preferredMode: 'perch' });
    } else if (nowSec >= enemy.gargoyle_mode_until) {
      randomizeGargoyleMode(enemy, nowSec);
    }
  } else if (nowSec >= enemy.gargoyle_mode_until) {
    randomizeGargoyleMode(enemy, nowSec, { preferredMode: Math.random() < 0.94 ? 'perch' : 'swoop' });
  }

  const ambushDistance = targetPlayer
    ? Math.hypot(targetPlayer.x - enemy.x, targetPlayer.y - enemy.y)
    : Number.POSITIVE_INFINITY;
  const isActivelyAttacking =
    enemy.brain_state === 'prepare' ||
    enemy.brain_state === 'lunge' ||
    enemy.brain_state === 'recover' ||
    ambushDistance <= GARGOYLE_AMBUSH_TRIGGER_RADIUS;
  enemy.render_opacity = !enemy.stealth_broken && enemy.gargoyle_mode === 'perch' && !isActivelyAttacking
    ? GARGOYLE_PERCH_OPACITY
    : GARGOYLE_ACTIVE_OPACITY;
}

function updateGhostOpacity(enemy, definition) {
  if (!isGhostEnemy(definition)) {
    return;
  }

  enemy.render_opacity = GHOST_PASSIVE_OPACITY;
}

function beginRecover(enemy, nowSec) {
  setBrainState(enemy, 'recover', nowSec);
  enemy.action = 'idle';
  enemy.recover_until = nowSec + (isStrikerEnemy(enemy) ? STRIKER_ASCEND_DURATION_SECONDS : 0.22);
  enemy.attack_release_at = 0;
  enemy.attack_shot_fired = false;
}

function getMovementJumpImpulse(definition, enemyFeetY, targetTopY, options = {}) {
  const gravityPerSecond = GRAVITY * 60;
  const maxJumpForce = Math.max(definition.behavior.jumpForce, Math.abs(JUMP_FORCE));
  const rise = Math.max(0, enemyFeetY - targetTopY);
  const safetyRise = rise + (options.extraRise ?? 26);
  const requiredForce = Math.sqrt(Math.max(0, 2 * gravityPerSecond * safetyRise));
  const minForce = maxJumpForce * (options.isDoubleJump ? 0.56 : 0.42);
  const cappedForce = options.isDoubleJump ? maxJumpForce * 0.92 : maxJumpForce;
  return Math.max(minForce, Math.min(cappedForce, requiredForce));
}

function getCachedChaseNavigationPlan(state, enemy, definition, targetPlayer, nowSec) {
  if (!targetPlayer) {
    enemy.nav_cache_key = '';
    enemy.nav_cache_until = 0;
    enemy.nav_cache_plan = null;
    return null;
  }

  const targetSid = enemy.target_sid ?? 'unknown';
  const enemyBucketX = Math.round(enemy.x / 24);
  const enemyBucketY = Math.round(enemy.y / 24);
  const playerBucketX = Math.round(targetPlayer.x / 24);
  const playerBucketY = Math.round(targetPlayer.y / 24);
  const cacheKey = `${targetSid}:${enemyBucketX}:${enemyBucketY}:${playerBucketX}:${playerBucketY}:${enemy.on_ground ? 1 : 0}`;

  if (
    enemy.nav_cache_key === cacheKey &&
    enemy.nav_cache_until > nowSec
  ) {
    return enemy.nav_cache_plan;
  }

  const plan = getChaseNavigationPlan(state, enemy, definition, targetPlayer);
  enemy.nav_cache_key = cacheKey;
  enemy.nav_cache_until = nowSec + 0.2;
  enemy.nav_cache_plan = plan;
  return plan;
}

function resolveChaseMoveIntent(enemy, navigationPlan, targetPlayer, definition) {
  const chaseTargetX = navigationPlan?.targetX ?? targetPlayer?.x ?? enemy.x;
  const chaseDx = chaseTargetX - enemy.x;
  const attackDx = (targetPlayer?.x ?? chaseTargetX) - enemy.x;
  const deadzone = navigationPlan?.pursuingPlatformFirst ? 8 : 12;

  if (Math.abs(chaseDx) > deadzone) {
    return Math.sign(chaseDx);
  }

  if (navigationPlan?.requiresJump) {
    if (Math.abs(attackDx) > 18) {
      return Math.sign(attackDx);
    }
    return enemy.direction === 'left' ? -1 : 1;
  }

  if (Math.abs(attackDx) > Math.max(28, definition.behavior.attackRange * 0.45)) {
    return Math.sign(attackDx);
  }

  return 0;
}

function getCommittedJumpTargetX(state, enemy, definition, moveIntent, targetPlayer, navigationPlan) {
  const mapMinX = state.mapBounds.min_x;
  const mapMaxX = state.mapBounds.max_x;
  const minCommitDistance = navigationPlan?.requiresJump
    ? Math.max(28, definition.behavior.moveSpeed * 0.2)
    : 0;

  let targetX = Number.isFinite(navigationPlan?.targetX)
    ? navigationPlan.targetX
    : (Number.isFinite(targetPlayer?.x) ? targetPlayer.x : enemy.x + moveIntent * 48);

  if (Math.abs(targetX - enemy.x) < minCommitDistance) {
    const playerDx = Number.isFinite(targetPlayer?.x) ? targetPlayer.x - enemy.x : 0;
    if (Math.abs(playerDx) >= minCommitDistance) {
      targetX = targetPlayer.x;
    } else {
      const fallbackIntent =
        moveIntent !== 0
          ? moveIntent
          : (Math.sign(playerDx || 0) || (enemy.direction === 'left' ? -1 : 1));
      targetX = enemy.x + fallbackIntent * Math.max(48, minCommitDistance);
    }
  }

  return clamp(targetX, mapMinX, mapMaxX);
}

function maybeJumpTowardTarget(state, enemy, definition, moveIntent, targetPlayer, navigationPlan, nowSec) {
  if (moveIntent === 0 && !navigationPlan?.jumpNow) {
    return;
  }

  const directionDelta = moveIntent * 10;
  const blockedAhead = moveIntent !== 0 && willEnemyCollideHorizontally(state, definition, enemy, directionDelta);
  const enemyHitbox = getEnemyHitboxForPosition(definition, enemy.x, enemy.y);
  const enemyFeetY = enemyHitbox.y + enemyHitbox.height;
  const climbTargetY = navigationPlan?.targetTopY ?? targetPlayer?.y ?? enemy.y;
  const needsExtraHeight = climbTargetY < enemyFeetY - 30;
  const sinceLastJump = nowSec - enemy.last_jump_at;
  const stuckDuration = getEnemyStuckDuration(enemy, moveIntent, nowSec);
  const wantsClimb = Boolean(navigationPlan?.playerIsAbove || needsExtraHeight);
  const linedUpForClimb = Boolean(navigationPlan?.requiresJump && navigationPlan?.jumpNow);
  const needsPlannedDouble = Boolean(navigationPlan?.needsDoubleJump);
  const preferGroundChase = Boolean(navigationPlan?.preferGroundChase);
  const horizontalTargetDistance = targetPlayer ? Math.abs(targetPlayer.x - enemy.x) : Math.abs((navigationPlan?.targetX ?? enemy.x) - enemy.x);

  if (preferGroundChase && !wantsClimb) {
    if (!blockedAhead) {
      return;
    }
    if (horizontalTargetDistance < Math.max(52, definition.behavior.attackRange * 0.55)) {
      return;
    }
    if (stuckDuration < 1.1) {
      return;
    }
  }

  if (
    enemy.on_ground &&
    enemy.jumps_remaining > 0 &&
    sinceLastJump >= secondsFromMs(definition.behavior.stuckJumpDelayMs) &&
    (blockedAhead || linedUpForClimb || (wantsClimb && stuckDuration >= 0.38) || stuckDuration >= 0.7)
  ) {
    const jumpTargetX = getCommittedJumpTargetX(
      state,
      enemy,
      definition,
      moveIntent,
      targetPlayer,
      navigationPlan
    );
    const jumpDeltaX = jumpTargetX - enemy.x;
    const forwardIntent = moveIntent !== 0
      ? moveIntent
      : (Math.sign(jumpDeltaX || 0) || (enemy.direction === 'left' ? -1 : 1));
    const launchMagnitude = Math.max(
      definition.behavior.moveSpeed * 1.05,
      Math.min(definition.behavior.lungeSpeed * 0.6, Math.abs(jumpDeltaX) * 2.4)
    );
    const jumpForce = getMovementJumpImpulse(definition, enemyFeetY, climbTargetY, {
      extraRise: blockedAhead && !wantsClimb ? 14 : 26,
      isDoubleJump: false,
    });
    enemy.vy = -jumpForce;
    enemy.jump_launch_vx = forwardIntent * launchMagnitude;
    enemy.on_ground = false;
    enemy.jumps_remaining -= 1;
    enemy.last_jump_at = nowSec;
    enemy.jump_start_y = enemy.y;
    enemy.jump_target_top_y = climbTargetY;
    enemy.jump_requires_double = needsPlannedDouble;
    return;
  }

  const stillBelowTarget = enemyFeetY > climbTargetY + 18;
  const profile = getNavigationProfile(definition);
  const climbedSinceFirstJump = enemy.jump_start_y - enemy.y;
  const nearApex = enemy.vy >= -90;
  const plannedDoubleWindowOpen =
    enemy.jump_requires_double &&
    enemy.jump_target_top_y > 0 &&
    enemyFeetY > enemy.jump_target_top_y + 12 &&
    climbedSinceFirstJump >= profile.singleJumpHeight * 0.55 &&
    sinceLastJump >= Math.max(0.12, secondsFromMs(definition.behavior.doubleJumpDelayMs) * 0.6) &&
    nearApex;
  const needsDoubleJump =
    plannedDoubleWindowOpen ||
    blockedAhead ||
    (wantsClimb && stillBelowTarget && enemy.vy > -180) ||
    (wantsClimb && stillBelowTarget && enemy.vy >= 0) ||
    (stuckDuration >= 0.9 && !enemy.on_ground);

  if (
    !enemy.on_ground &&
    enemy.jumps_remaining > 0 &&
    (plannedDoubleWindowOpen || sinceLastJump >= secondsFromMs(definition.behavior.doubleJumpDelayMs)) &&
    needsDoubleJump
  ) {
    const jumpTargetX = getCommittedJumpTargetX(
      state,
      enemy,
      definition,
      moveIntent,
      targetPlayer,
      navigationPlan
    );
    const jumpDeltaX = jumpTargetX - enemy.x;
    const forwardIntent = moveIntent !== 0
      ? moveIntent
      : (Math.sign(jumpDeltaX || 0) || (enemy.direction === 'left' ? -1 : 1));
    const relaunchMagnitude = Math.max(
      definition.behavior.moveSpeed * 1.08,
      Math.min(definition.behavior.lungeSpeed * 0.68, Math.abs(jumpDeltaX) * 2.8)
    );
    const jumpForce = getMovementJumpImpulse(definition, enemyFeetY, climbTargetY, {
      extraRise: 20,
      isDoubleJump: true,
    });
    enemy.vy = -jumpForce;
    enemy.jump_launch_vx = forwardIntent * relaunchMagnitude;
    enemy.jumps_remaining -= 1;
    enemy.last_jump_at = nowSec;
    enemy.jump_requires_double = false;
  }
}

function applyEnemyPhysics(state, enemy, definition, dt, desiredVelocityX) {
  const prevX = enemy.x;
  const prevY = enemy.y;
  const knockbackVx = Number.isFinite(enemy.knockback_vx) ? enemy.knockback_vx : 0;
  let movementVx = desiredVelocityX;
  if (!enemy.on_ground && enemy.brain_state !== 'lunge' && Number.isFinite(enemy.jump_launch_vx)) {
    const launchWeight = Math.max(0, Math.min(1, Math.abs(enemy.vy) / Math.max(1, definition.behavior.jumpForce)));
    movementVx = enemy.jump_launch_vx * (0.72 + launchWeight * 0.28);
    enemy.jump_launch_vx *= 0.94;
    if (Math.abs(enemy.jump_launch_vx) < definition.behavior.moveSpeed * 0.2) {
      enemy.jump_launch_vx = 0;
    }
  }
  enemy.vx = movementVx + knockbackVx;
  if (enemy.vx > 8) {
    enemy.direction = 'right';
  } else if (enemy.vx < -8) {
    enemy.direction = 'left';
  }
  enemy.x += enemy.vx * dt;

  clampEnemyToBounds(state, definition, enemy);

  const nearby = getNearbyPlatforms({
    platformGrid: state.platformGrid,
    x: enemy.x,
    y: enemy.y,
  });
  resolveEnemyHorizontalCollisions(state, definition, enemy, prevX, nearby);

  enemy.vy += GRAVITY * dt * 60;
  enemy.y += enemy.vy * dt;
  enemy.on_ground = false;

  clampEnemyToBounds(state, definition, enemy);
  resolveEnemyVerticalCollisions(state, definition, enemy, prevY, nearby);

  if (Math.abs(knockbackVx) < 10) {
    enemy.knockback_vx = 0;
  } else {
    enemy.knockback_vx = knockbackVx * 0.82;
  }
}

function getFlyingEnemyTargetY(enemy, definition, targetPlayer, nowSec) {
  const bobAmplitude = definition.behavior.hoverBobAmplitude;
  const bobSpeed = definition.behavior.hoverBobSpeed;
  const bobOffset = Math.sin(nowSec * bobSpeed + stableEnemyPhase(enemy)) * bobAmplitude;

  if (targetPlayer) {
    if (isGhostEnemy(definition)) {
      return targetPlayer.y + bobOffset;
    }
    const desiredBaseY = targetPlayer.y + (enemy.attack_altitude_bias ?? -definition.behavior.hoverHeight);
    const minY = targetPlayer.y - definition.behavior.hoverHeight - definition.behavior.hoverVariance;
    const maxY = targetPlayer.y + Math.min(52, definition.behavior.hoverVariance * 0.28);
    return clamp(desiredBaseY + bobOffset, minY, maxY);
  }

  return enemy.spawn_y - definition.behavior.hoverHeight * 0.35 + bobOffset;
}

function stableEnemyPhase(enemy) {
  let hash = 0;
  const id = String(enemy?.id ?? '');
  for (let index = 0; index < id.length; index += 1) {
    hash = ((hash << 5) - hash) + id.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash % 628) / 100;
}

function applyFlyingEnemyPhysics(state, enemy, definition, dt, desiredVelocityX, desiredVelocityY) {
  const prevX = enemy.x;
  const prevY = enemy.y;
  const knockbackVx = Number.isFinite(enemy.knockback_vx) ? enemy.knockback_vx : 0;
  const targetVx = desiredVelocityX + knockbackVx;
  const targetVy = desiredVelocityY;
  const horizontalEase = dt >= (1 / 50) ? 0.18 : 0.13;
  const verticalEase = dt >= (1 / 50) ? 0.16 : 0.11;

  enemy.vx += (targetVx - enemy.vx) * horizontalEase;
  enemy.vy += (targetVy - enemy.vy) * verticalEase;

  if (enemy.vx > 8) {
    enemy.direction = 'right';
  } else if (enemy.vx < -8) {
    enemy.direction = 'left';
  }

  enemy.x += enemy.vx * dt;
  const nearbyAfterX = getNearbyPlatforms({
    platformGrid: state.platformGrid,
    x: enemy.x,
    y: enemy.y,
  });
  if (nearbyAfterX.some((platform) => checkEnemyPlatformCollision(definition, enemy.x, enemy.y, platform))) {
    enemy.x = prevX;
    enemy.vx = 0;
  }

  enemy.y += enemy.vy * dt;
  const nearbyAfterY = getNearbyPlatforms({
    platformGrid: state.platformGrid,
    x: enemy.x,
    y: enemy.y,
  });
  if (nearbyAfterY.some((platform) => checkEnemyPlatformCollision(definition, enemy.x, enemy.y, platform))) {
    enemy.y = prevY;
    enemy.vy = 0;
  }

  clampEnemyToBounds(state, definition, enemy);
  enemy.on_ground = false;
  enemy.jumps_remaining = 2;
  enemy.jump_launch_vx = 0;

  const hitboxAfterClamp = getEnemyHitboxForPosition(definition, enemy.x, enemy.y);
  if (hitboxAfterClamp && hitboxAfterClamp.y <= state.mapBounds.min_y + 2) {
    enemy.attack_altitude_bias = Math.max(20, definition.behavior.hoverVariance * 0.18);
    enemy.next_altitude_swap_at = 0;
    enemy.vy = Math.max(enemy.vy, definition.behavior.verticalMoveSpeed * 0.45);
  }

  const trapEscape = getFlyingCeilingTrapEscape(state, enemy, definition);
  if (trapEscape) {
    const escapeDx = trapEscape.escapeX - enemy.x;
    const escapeDy = trapEscape.escapeY - enemy.y;
    enemy.attack_altitude_bias = Math.max(24, definition.behavior.hoverVariance * 0.24);
    enemy.next_altitude_swap_at = 0;
    enemy.vx = Math.abs(escapeDx) > 8
      ? Math.sign(escapeDx) * Math.max(Math.abs(enemy.vx), definition.behavior.moveSpeed * 0.78)
      : enemy.vx * 0.88;
    enemy.vy = Math.abs(escapeDy) > 8
      ? Math.sign(escapeDy) * Math.max(Math.abs(enemy.vy), definition.behavior.verticalMoveSpeed * 0.95)
      : Math.max(enemy.vy, definition.behavior.verticalMoveSpeed * 0.32);
  }

  if (Math.abs(targetVx) < 8 && Math.abs(enemy.vx) < 8) {
    enemy.vx *= 0.94;
  }
  if (Math.abs(targetVy) < 8 && Math.abs(enemy.vy) < 8) {
    enemy.vy *= 0.9;
  }

  if (Math.abs(knockbackVx) < 10) {
    enemy.knockback_vx = 0;
  } else {
    enemy.knockback_vx = knockbackVx * 0.82;
  }
}

function damagePlayerFromEnemyHit(input) {
  const { player, enemy, definition, nowSec } = input;
  if (player.is_dying) {
    return;
  }

  const directionSign = enemy.direction === 'left' ? -1 : 1;
  if (!input.skipKnockback) {
    player.knockback_vx = directionSign * 720;
    player.vy = Math.min(player.vy, -420);
    player.on_ground = false;
    player.jumps_remaining = 0;
  }
  const reduction = Math.max(0, Math.min(0.72, Number(getPlayerRunStats(player).damageReduction) || 0));
  const finalDamage = Math.max(1, Math.round(definition.stats.contactDamage * (1 - reduction)));
  player.health -= finalDamage;

  if (player.health <= 0) {
    player.health = 0;
    player.is_dying = true;
    player.death_time = nowSec;
    despawnEnemiesSpawnedForPlayer(input.state, input.sid);
    dropSoulsForPlayerDeath(input.state, input.io, player);
    input.io.emit('player_dying', {
      sid: input.sid,
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
    sid: input.sid,
    damage: finalDamage,
    health: player.health,
    is_dying: player.is_dying,
    x: Number.isFinite(input.impactX) ? input.impactX : enemy.x,
    y: Number.isFinite(input.impactY) ? input.impactY : enemy.y,
    effect: input.effect || 'blood',
  });
}

function latchSlimeToPlayer(state, enemy, player, sid, nowSec, definition, io) {
  enemy.attached_sid = sid;
  enemy.attached_offset_x = enemy.direction === 'left' ? -14 : 14;
  enemy.attached_offset_y = SLIME_ATTACH_OFFSET_Y - Math.min(8, getEnemyShape(definition).height * 0.08);
  enemy.vx = 0;
  enemy.vy = 0;
  enemy.knockback_vx = 0;
  enemy.jump_launch_vx = 0;
  enemy.on_ground = false;
  enemy.action = 'attack';
  enemy.target_sid = sid;
  enemy.surface_stick_until = 0;
  setBrainState(enemy, 'cling', nowSec);
  enemy.attack_cooldown_until = nowSec + secondsFromMs(definition.behavior.attackCooldownMs);
  enemy.x = player.x + enemy.attached_offset_x;
  enemy.y = player.y + enemy.attached_offset_y;
  emitSlimeSplatter(state, io, enemy.x, enemy.y, sid, SLIME_SPLAT_RADIUS);
}

function detachSlime(enemy, nowSec) {
  enemy.attached_sid = null;
  enemy.attached_offset_x = 0;
  enemy.attached_offset_y = SLIME_ATTACH_OFFSET_Y;
  enemy.surface_stick_until = 0;
  enemy.target_sid = null;
  enemy.vx = 0;
  enemy.vy = Math.min(enemy.vy, -220);
  enemy.knockback_vx *= 0.6;
  enemy.jump_launch_vx = 0;
  enemy.on_ground = false;
  enemy.action = 'idle';
  setBrainState(enemy, 'recover', nowSec);
  enemy.recover_until = nowSec + 0.36;
}

function updateAttachedSlime(input) {
  const { state, enemy, definition, io, nowSec } = input;
  const targetSid = enemy.attached_sid;
  if (!targetSid) {
    return false;
  }

  const player = state.players.get(targetSid);
  if (!player || player.is_dying) {
    detachSlime(enemy, nowSec);
    return true;
  }

  enemy.target_sid = targetSid;
  enemy.direction = player.direction === 'left' ? 'left' : 'right';
  const directionOffset = enemy.direction === 'left' ? -Math.abs(enemy.attached_offset_x || 14) : Math.abs(enemy.attached_offset_x || 14);
  enemy.x = player.x + directionOffset;
  enemy.y = player.y + (enemy.attached_offset_y || SLIME_ATTACH_OFFSET_Y);
  enemy.vx = 0;
  enemy.vy = 0;
  enemy.knockback_vx = 0;
  enemy.jump_launch_vx = 0;
  enemy.on_ground = false;
  enemy.action = 'attack';

  if (nowSec >= enemy.attack_cooldown_until) {
    damagePlayerFromEnemyHit({
      state,
      io,
      sid: targetSid,
      player,
      enemy,
      definition,
      nowSec,
      impactX: enemy.x,
      impactY: enemy.y,
      effect: 'slime',
      skipKnockback: true,
    });
    emitSlimeSplatter(state, io, enemy.x, enemy.y, targetSid, SLIME_SPLAT_RADIUS);
    enemy.attack_cooldown_until = nowSec + secondsFromMs(definition.behavior.attackCooldownMs);
  }

  return true;
}

function maybeStickSlimeToSurface(state, enemy, definition, nowSec, io) {
  if (!isSlimeEnemy(definition) || enemy.attached_sid || enemy.brain_state !== 'lunge') {
    return;
  }

  const hitbox = getEnemyHitbox(state, enemy);
  if (!hitbox) {
    return;
  }

  const touchingBounds =
    hitbox.x <= state.mapBounds.min_x + 2 ||
    hitbox.x + hitbox.width >= state.mapBounds.max_x - 2;
  const nearbyPlatforms = getNearbyPlatforms({
    platformGrid: state.platformGrid,
    x: enemy.x,
    y: enemy.y,
  });
  const touchingWall = nearbyPlatforms.some((platform) => {
    const verticallyAligned =
      hitbox.y < platform.y + platform.h &&
      hitbox.y + hitbox.height > platform.y;
    if (!verticallyAligned) {
      return false;
    }

    const distanceToLeft = Math.abs(hitbox.x + hitbox.width - platform.x);
    const distanceToRight = Math.abs(platform.x + platform.w - hitbox.x);
    return distanceToLeft <= 6 || distanceToRight <= 6;
  });
  const touchedSurface = enemy.on_ground || touchingBounds || touchingWall;
  if (!touchedSurface) {
    return;
  }

  emitSlimeSplatter(state, io, enemy.x, enemy.y, null, SLIME_SPLAT_RADIUS);
  enemy.surface_stick_until = nowSec + SLIME_WALL_STICK_SECONDS;
  enemy.vx = 0;
  enemy.vy = 0;
  enemy.knockback_vx = 0;
  enemy.jump_launch_vx = 0;
  enemy.action = 'attack';
  setBrainState(enemy, 'recover', nowSec);
  enemy.recover_until = Math.max(enemy.recover_until || 0, enemy.surface_stick_until);
}

function processEnemyAttackHits(input) {
  if (usesProjectileAttackForEnemy(input.enemy, input.definition)) {
    return;
  }

  if (input.enemy.brain_state !== 'lunge') {
    return;
  }

  const hitVictims = new Set(input.enemy.attack_hit_victims);
  for (const [sid, player] of input.state.players.entries()) {
    if (hitVictims.has(sid) || player.is_dying) {
      continue;
    }

    if (!checkEnemyPlayerCollision(input.state, input.enemy, player)) {
      continue;
    }

    hitVictims.add(sid);
    damagePlayerFromEnemyHit({
      ...input,
      sid,
      player,
      nowSec: input.nowSec,
      effect: isSlimeEnemy(input.definition) ? 'slime' : 'blood',
    });
    if (isSlimeEnemy(input.definition)) {
      latchSlimeToPlayer(input.state, input.enemy, player, sid, input.nowSec, input.definition, input.io);
      break;
    }
  }

  input.enemy.attack_hit_victims = Array.from(hitVictims);
}

function processStrikerTouchDamage(input) {
  if (!isStrikerEnemy(input.definition) || !input.enemy.alive) {
    return;
  }

  if (!input.enemy.contact_hit_cooldowns || typeof input.enemy.contact_hit_cooldowns !== 'object') {
    input.enemy.contact_hit_cooldowns = {};
  }

  for (const [sid, player] of input.state.players.entries()) {
    if (player.is_dying) {
      continue;
    }

    if (!checkEnemyPlayerCollision(input.state, input.enemy, player)) {
      continue;
    }

    const readyAt = Number(input.enemy.contact_hit_cooldowns[sid]) || 0;
    if (input.nowSec < readyAt) {
      continue;
    }

    input.enemy.direction = player.x < input.enemy.x ? 'left' : 'right';
    damagePlayerFromEnemyHit({
      ...input,
      sid,
      player,
      nowSec: input.nowSec,
      impactX: input.enemy.x,
      impactY: input.enemy.y,
      effect: 'blood',
    });
    input.enemy.contact_hit_cooldowns[sid] = input.nowSec + STRIKER_TOUCH_DAMAGE_COOLDOWN_SECONDS;
  }
}

function maybeFireEnemyProjectile(input) {
  const { enemy, definition, targetPlayer, nowSec } = input;
  if (!usesProjectileAttackForEnemy(enemy, definition) || !targetPlayer || enemy.attack_shot_fired) {
    return;
  }
  if (enemy.brain_state !== 'prepare' && enemy.brain_state !== 'lunge') {
    return;
  }
  if (nowSec < enemy.attack_release_at) {
    return;
  }

  const origin = getEnemyProjectileOrigin(enemy, definition);
  const targetX = targetPlayer.x;
  const targetY = targetPlayer.y - PLAYER_HITBOX_HEIGHT * 0.2;
  const dx = targetX - origin.x;
  const dy = targetY - origin.y;
  const speed = definition.behavior.projectileSpeed;
  const aimAngle = Math.atan2(dy, dx);
  const aimJitterRadians = Math.max(0, Number(definition.behavior.projectileAimJitterRadians) || 0);
  const firedAngle = aimAngle + (aimJitterRadians > 0 ? (Math.random() * 2 - 1) * aimJitterRadians : 0);
  const vx = Math.cos(firedAngle) * speed;
  const vy = Math.sin(firedAngle) * speed;

  if (Math.abs(vx) > 8) {
    enemy.direction = vx < 0 ? 'left' : 'right';
  }

  input.spawnFireball({
    state: input.state,
    io: input.io,
    ownerType: 'enemy',
    ownerEnemyId: enemy.id,
    ownerSid: null,
    x: origin.x,
    y: origin.y,
    vx,
    vy,
    damage: definition.behavior.projectileDamage,
    renderScale: definition.behavior.projectileScale,
    radiusScale: definition.behavior.projectileRadiusScale,
  });
  enemy.attack_shot_fired = true;
}

function markEnemyDead(input) {
  const { enemy, definition, sourceVx, sourceVy, nowSec } = input;
  const despawnFadeSec = secondsFromMs(definition.behavior.despawnAfterDeathMs);
  const respawnDelaySec = Math.max(MIN_ENEMY_RESPAWN_DELAY_SECONDS, secondsFromMs(definition.stats.respawnDelayMs));
  setBrainState(enemy, 'dead', nowSec);
  enemy.action = 'death';
  enemy.alive = false;
  enemy.death_time = nowSec;
  enemy.despawn_at = nowSec + ENEMY_DEATH_HOLD_SECONDS + despawnFadeSec;
  enemy.respawn_at = enemy.despawn_at + respawnDelaySec;
  enemy.vx = 0;
  enemy.knockback_vx = Math.sign(sourceVx || (enemy.direction === 'left' ? -1 : 1)) * 260;
  enemy.direction = chooseEnemyDeathDirection(enemy, enemy.knockback_vx);
  enemy.vy = -Math.max(240, Math.abs(sourceVy || 0) * 0.35 + 220);
  enemy.on_ground = false;
  enemy.jumps_remaining = 0;
}

function stageEnemyRespawn(enemy, definition, nowSec) {
  enemy.x = enemy.spawn_x;
  enemy.y = enemy.spawn_y;
  enemy.vx = 0;
  enemy.vy = 0;
  enemy.knockback_vx = 0;
  enemy.on_ground = false;
  enemy.jumps_remaining = 2;
  enemy.direction = 'right';
  enemy.action = 'idle';
  enemy.brain_state = 'idle';
  enemy.state_started_at = nowSec;
  enemy.target_sid = null;
  enemy.aggro_until = 0;
  enemy.wander_target_x = enemy.spawn_x;
  enemy.next_decision_at = nowSec + 1 + Math.random();
  enemy.last_jump_at = 0;
  enemy.last_progress_x = enemy.x;
  enemy.last_progress_y = enemy.y;
  enemy.last_progress_at = nowSec;
  enemy.jump_start_y = enemy.y;
  enemy.jump_target_top_y = 0;
  enemy.jump_requires_double = false;
  enemy.jump_launch_vx = 0;
  enemy.attack_cooldown_until = 0;
  enemy.prepare_until = 0;
  enemy.lunge_until = 0;
  enemy.recover_until = 0;
  enemy.attack_release_at = 0;
  enemy.attack_shot_fired = false;
  enemy.attack_hit_victims = [];
  enemy.health = definition.stats.maxHealth;
  enemy.max_health = definition.stats.maxHealth;
  enemy.alive = false;
  enemy.death_time = 0;
  enemy.despawn_at = 0;
  enemy.nav_cache_key = '';
  enemy.nav_cache_until = 0;
  enemy.nav_cache_plan = null;
  enemy.preferred_hover_y = enemy.spawn_y - definition.behavior.hoverHeight;
  enemy.attack_altitude_bias = -definition.behavior.hoverHeight;
  enemy.next_altitude_swap_at = nowSec + 0.7 + Math.random() * 0.8;
  enemy.attached_sid = null;
  enemy.attached_offset_x = 0;
  enemy.attached_offset_y = SLIME_ATTACH_OFFSET_Y;
  enemy.surface_stick_until = 0;
  enemy.gargoyle_mode = isGargoyleEnemy(definition) ? (Math.random() < 0.55 ? 'perch' : 'swoop') : null;
  enemy.gargoyle_mode_until = nowSec + 2.4 + Math.random() * 2.6;
  enemy.gargoyle_perch_opacity = enemy.gargoyle_mode === 'perch' ? GARGOYLE_PERCH_OPACITY : GARGOYLE_ACTIVE_OPACITY;
  enemy.render_opacity = isGhostEnemy(definition) ? GHOST_PASSIVE_OPACITY : (enemy.gargoyle_mode === 'perch' ? GARGOYLE_PERCH_OPACITY : GARGOYLE_ACTIVE_OPACITY);
  enemy.stealth_broken = false;
  enemy.attack_repeat_next_at = 0;
  enemy.environment_attack_cooldown_until = 0;
  enemy.striker_slam_started_at = 0;
  enemy.striker_slam_impacted_at = 0;
  enemy.striker_recover_until = 0;
  enemy.contact_hit_cooldowns = {};
}

function damageEnemy(input) {
  const enemy = input.state.enemies.get(input.enemyId);
  if (!enemy || !enemy.alive) {
    return false;
  }

  const definition = enemy.runtime_definition || getEnemyDefinition(input.state, enemy.type);
  if (!definition) {
    return false;
  }

  const nowSec = Date.now() / 1000;
  const wasAttachedSlime = isSlimeEnemy(definition) && enemy.attached_sid;
  if (wasAttachedSlime) {
    emitSlimeSplatter(input.state, input.io, enemy.x, enemy.y, enemy.attached_sid, SLIME_SPLAT_RADIUS);
    detachSlime(enemy, nowSec);
  }
  if (isGargoyleEnemy(definition)) {
    enemy.stealth_broken = true;
    enemy.render_opacity = GARGOYLE_ACTIVE_OPACITY;
  }
  enemy.target_sid = typeof input.sourceSid === 'string' ? input.sourceSid : enemy.target_sid;
  enemy.aggro_until = nowSec + 6;
  enemy.direction = (input.sourceVx ?? 0) < 0 ? 'left' : 'right';
  enemy.health = Math.max(0, enemy.health - Math.max(1, Math.round(input.damage ?? 1)));

  if (enemy.health <= 0) {
    markEnemyDead({
      enemy,
      definition,
      sourceVx: input.sourceVx,
      sourceVy: input.sourceVy,
      nowSec,
    });
    dropSoulsForEnemyDeath(input.state, input.io, enemy);
    if (input.sourceSid) {
      const player = input.state.players.get(input.sourceSid);
      if (player) {
        const xpGain = Math.max(18, 14 + Math.round((enemy.level || 1) * 4.5));
        const xpResult = gainPlayerXp(player, xpGain);
        const unlockedAggroWarning = consumeAggroUnlockNotification(player);
        const unlockedAchievements = recordProgressionMetric(player, 'enemyKills', 1);
        emitProgressionNotification(input.io, input.sourceSid, {
          type: 'enemy_kill',
          xp: xpResult.gainedXp,
          message: `you killed ${(enemy.type || 'enemy').toLowerCase()} lvl. ${enemy.level || 1}`,
          caption: `+${xpResult.gainedXp} xp`,
        });
        if (unlockedAggroWarning) {
          emitProgressionNotification(input.io, input.sourceSid, unlockedAggroWarning);
        }
        for (const achievement of unlockedAchievements) {
          emitProgressionNotification(input.io, input.sourceSid, achievement);
        }
      }
    }
    return true;
  }

  enemy.knockback_vx = Math.sign(input.sourceVx || (enemy.direction === 'left' ? -1 : 1)) * 140;
  enemy.vy = Math.min(enemy.vy, -180);
  return true;
}

function despawnEnemiesSpawnedForPlayer(state, sid) {
  if (!state?.enemies || !sid) {
    return;
  }

  for (const [enemyId, enemy] of state.enemies.entries()) {
    const belongsToPlayer =
      enemy?.spawned_for_sid === sid ||
      enemy?.target_sid === sid ||
      enemy?.attached_sid === sid;
    if (!belongsToPlayer) {
      continue;
    }
    state.enemies.delete(enemyId);
  }

  if (Array.isArray(state.enemySpawns)) {
    state.enemySpawns = state.enemySpawns.filter((spawn) => spawn?.spawned_for_sid !== sid);
  }
}

function respawnEnemy(state, enemy, definition) {
  const occupiedSpawns = [];
  for (const otherEnemy of state.enemies.values()) {
    if (!otherEnemy || otherEnemy.id === enemy.id || !otherEnemy.alive) {
      continue;
    }
    const otherDefinition = getEnemyDefinition(state, otherEnemy.type);
    if (!otherDefinition) {
      continue;
    }
    occupiedSpawns.push({
      x: otherEnemy.x,
      y: otherEnemy.y,
      definition: otherDefinition,
    });
  }

  const baseDefinition = getEnemyDefinition(state, enemy.type) || definition;
  const nextLevel = rollEnemySpawnLevel(getWorldThreatLevel(state), enemy.type);
  if (nextLevel > 0 && baseDefinition) {
    enemy.level = nextLevel;
    enemy.runtime_definition = buildScaledEnemyDefinition(baseDefinition, nextLevel);
    definition = enemy.runtime_definition;
  }

  const nextSpawn = pickEnemySpawnPosition(state, definition, occupiedSpawns, {
    anchorPlayer: getDynamicSpawnAnchor(state)?.player ?? null,
  });
  if (nextSpawn) {
    enemy.spawn_x = nextSpawn.x;
    enemy.spawn_y = nextSpawn.y;
  }

  enemy.x = enemy.spawn_x;
  enemy.y = enemy.spawn_y;
  enemy.vx = 0;
  enemy.vy = 0;
  enemy.knockback_vx = 0;
  enemy.on_ground = false;
  enemy.jumps_remaining = 2;
  enemy.direction = 'right';
  enemy.action = 'idle';
  enemy.brain_state = 'idle';
  enemy.state_started_at = Date.now() / 1000;
  enemy.target_sid = null;
  enemy.aggro_until = 0;
  enemy.wander_target_x = enemy.spawn_x;
  enemy.next_decision_at = enemy.state_started_at + 1 + Math.random();
  enemy.last_jump_at = 0;
  enemy.last_progress_x = enemy.x;
  enemy.last_progress_y = enemy.y;
  enemy.last_progress_at = enemy.state_started_at;
  enemy.jump_start_y = enemy.y;
  enemy.jump_target_top_y = 0;
  enemy.jump_requires_double = false;
  enemy.jump_launch_vx = 0;
  enemy.attack_cooldown_until = 0;
  enemy.prepare_until = 0;
  enemy.lunge_until = 0;
  enemy.recover_until = 0;
  enemy.attack_release_at = 0;
  enemy.attack_shot_fired = false;
  enemy.attack_hit_victims = [];
  enemy.health = definition.stats.maxHealth;
  enemy.max_health = definition.stats.maxHealth;
  enemy.alive = true;
  enemy.death_time = 0;
  enemy.despawn_at = 0;
  enemy.respawn_at = 0;
  enemy.spawn_time_ms = Date.now();
  enemy.spawn_protected_until_ms = enemy.spawn_time_ms + ENEMY_SPAWN_GRACE_MS;
  enemy.nav_cache_key = '';
  enemy.nav_cache_until = 0;
  enemy.nav_cache_plan = null;
  enemy.preferred_hover_y = enemy.spawn_y - definition.behavior.hoverHeight;
  enemy.attack_altitude_bias = -definition.behavior.hoverHeight;
  enemy.next_altitude_swap_at = enemy.state_started_at + 0.7 + Math.random() * 0.8;
  enemy.attached_sid = null;
  enemy.attached_offset_x = 0;
  enemy.attached_offset_y = SLIME_ATTACH_OFFSET_Y;
  enemy.surface_stick_until = 0;
  enemy.gargoyle_mode = isGargoyleEnemy(definition) ? (Math.random() < 0.55 ? 'perch' : 'swoop') : null;
  enemy.gargoyle_mode_until = enemy.state_started_at + 2.4 + Math.random() * 2.6;
  enemy.gargoyle_perch_opacity = enemy.gargoyle_mode === 'perch' ? GARGOYLE_PERCH_OPACITY : GARGOYLE_ACTIVE_OPACITY;
  enemy.render_opacity = isGhostEnemy(definition) ? GHOST_PASSIVE_OPACITY : (enemy.gargoyle_mode === 'perch' ? GARGOYLE_PERCH_OPACITY : GARGOYLE_ACTIVE_OPACITY);
  enemy.stealth_broken = false;
  enemy.attack_repeat_next_at = 0;
  enemy.environment_attack_cooldown_until = 0;
  enemy.striker_slam_started_at = 0;
  enemy.striker_slam_impacted_at = 0;
  enemy.striker_recover_until = 0;
  enemy.contact_hit_cooldowns = {};
}

function updateDeadEnemy(state, enemy, definition, dt, nowSec) {
  if (enemy.respawn_at > 0 && nowSec >= enemy.respawn_at) {
    respawnEnemy(state, enemy, definition);
    return;
  }

  if (enemy.despawn_at > 0 && nowSec >= enemy.despawn_at) {
    stageEnemyRespawn(enemy, definition, nowSec);
    return;
  }

  const desiredVelocityX = 0;
  applyEnemyPhysics(state, enemy, definition, dt, desiredVelocityX);
  enemy.action = 'death';
}

function updateAliveEnemy(input) {
  const { state, enemy, definition, dt, nowSec } = input;
  if (isSlimeEnemy(definition) && updateAttachedSlime(input)) {
    return;
  }

  const targetPlayer = chooseTargetPlayer(state, enemy, definition, nowSec);
  enemy.target_sid = targetPlayer ? enemy.target_sid : null;
  updateGargoyleMode(state, enemy, definition, targetPlayer, nowSec);
  updateGhostOpacity(enemy, definition);
  const flying = isFlyingEnemy(definition);

  let desiredVelocityX = 0;
  let desiredVelocityY = 0;
  let moveIntent = 0;
  let navigationPlan = null;

  if (enemy.brain_state === 'prepare') {
    enemy.action = 'prepare';
    if (targetPlayer) {
      enemy.direction = targetPlayer.x < enemy.x ? 'left' : 'right';
    }
    maybeFireEnemyProjectile({
      ...input,
      enemy,
      definition,
      targetPlayer,
      nowSec,
    });
    if (isStrikerEnemy(definition) && targetPlayer) {
      const alignDx = targetPlayer.x - enemy.x;
      const desiredPrepY = targetPlayer.y - Math.max(definition.behavior.hoverHeight, definition.behavior.attackRange * 0.28);
      const alignDy = desiredPrepY - enemy.y;
      desiredVelocityX = Math.abs(alignDx) > 12
        ? Math.sign(alignDx) * definition.behavior.moveSpeed * (Math.abs(alignDx) > 120 ? 1.6 : 1.25)
        : 0;
      desiredVelocityY = Math.abs(alignDy) > 10
        ? Math.sign(alignDy) * definition.behavior.verticalMoveSpeed * (alignDy < 0 ? 1.8 : 1.15)
        : 0;
    }
    if (nowSec >= enemy.prepare_until) {
      if (isStrikerEnemy(definition) && targetPlayer) {
        const slamDx = Math.abs(targetPlayer.x - enemy.x);
        const slamTargetY = targetPlayer.y - Math.max(definition.behavior.hoverHeight * 0.34, 44);
        const slamDy = Math.abs(slamTargetY - enemy.y);
        const directDiveWindow =
          hasLineOfSightToPlayer(state, enemy, targetPlayer) &&
          slamDx <= Math.max(140, definition.behavior.attackRange * 0.34) &&
          Math.abs(targetPlayer.y - enemy.y) <= Math.max(132, definition.behavior.hoverHeight * 0.9);
        const horizontallyAligned = directDiveWindow || slamDx <= Math.max(82, definition.behavior.attackRange * 0.2);
        const verticallyAligned = directDiveWindow || slamDy <= Math.max(108, definition.behavior.hoverVariance * 1.18);
        if (!horizontallyAligned || !verticallyAligned) {
          enemy.prepare_until = nowSec + 0.08;
          enemy.attack_release_at = enemy.prepare_until;
        } else {
          beginLunge(enemy, targetPlayer, nowSec, definition);
          desiredVelocityX = enemy.vx;
        }
      } else {
        if (isGhostEnemy(definition) && targetPlayer && !hasLineOfSightToPlayer(state, enemy, targetPlayer)) {
          setBrainState(enemy, 'chase', nowSec);
          enemy.attack_cooldown_until = nowSec + 0.5;
        } else {
          beginLunge(enemy, targetPlayer, nowSec, definition);
          desiredVelocityX = enemy.vx;
        }
      }
    }
  } else if (enemy.brain_state === 'lunge') {
    enemy.action = 'attack';
    desiredVelocityX = enemy.vx;
    if (isStrikerEnemy(definition)) {
      desiredVelocityX = enemy.vx;
      desiredVelocityY = Math.max(definition.behavior.verticalMoveSpeed * 2.6, enemy.vy);
    }
    maybeFireEnemyProjectile({
      ...input,
      enemy,
      definition,
      targetPlayer,
      nowSec,
    });
    if (isStrikerEnemy(definition) && nowSec >= enemy.lunge_until && !enemy.on_ground) {
      enemy.lunge_until = nowSec + 0.08;
    } else if (nowSec >= enemy.lunge_until) {
      beginRecover(enemy, nowSec);
      desiredVelocityX = 0;
    }
  } else if (enemy.brain_state === 'recover') {
    enemy.action = isSlimeEnemy(definition) && nowSec < enemy.surface_stick_until ? 'attack' : 'idle';
    if (isStrikerEnemy(definition)) {
      const recoverTargetY = getFlyingEnemyTargetY(enemy, definition, targetPlayer, nowSec) - Math.max(48, definition.behavior.hoverHeight * 0.18);
      const recoverDy = recoverTargetY - enemy.y;
      desiredVelocityY = Math.abs(recoverDy) > 12
        ? Math.sign(recoverDy) * definition.behavior.verticalMoveSpeed * 1.25
        : 0;
      if (targetPlayer) {
        const recoverDx = targetPlayer.x - enemy.x;
        desiredVelocityX = Math.abs(recoverDx) > 28
          ? Math.sign(recoverDx) * definition.behavior.moveSpeed * 0.42
          : 0;
      }
      enemy.striker_recover_until = enemy.recover_until;
    }
    if (nowSec >= enemy.recover_until) {
      enemy.surface_stick_until = 0;
      setBrainState(enemy, targetPlayer ? 'chase' : 'idle', nowSec);
    }
  } else if (targetPlayer) {
    if (isGargoyleEnemy(definition) && enemy.gargoyle_mode === 'perch') {
      const ambushDx = targetPlayer.x - enemy.x;
      const ambushDistance = Math.hypot(ambushDx, targetPlayer.y - enemy.y);
      desiredVelocityX = 0;
      desiredVelocityY = 0;
      enemy.direction = targetPlayer.x < enemy.x ? 'left' : 'right';
      enemy.attack_altitude_bias = 0;
      setBrainState(enemy, 'idle', nowSec);

      if (
        nowSec >= enemy.attack_cooldown_until &&
        ambushDistance <= GARGOYLE_AMBUSH_TRIGGER_RADIUS &&
        Math.abs(targetPlayer.y - enemy.y) <= 72 &&
        hasLineOfSightToPlayer(state, enemy, targetPlayer)
      ) {
        beginPrepare(enemy, targetPlayer, nowSec, definition);
        desiredVelocityX = 0;
        desiredVelocityY = 0;
      }
    } else if (flying) {
      const attackDx = targetPlayer.x - enemy.x;
      const orbitTarget = getFlyingOrbitTarget(state, enemy, definition, targetPlayer, nowSec);
      const strikerDirectChargeWindow =
        isStrikerEnemy(definition) &&
        hasLineOfSightToPlayer(state, enemy, targetPlayer) &&
        Math.abs(targetPlayer.y - enemy.y) <= Math.max(132, definition.behavior.hoverHeight * 0.86);
      let detourPlan = strikerDirectChargeWindow
        ? null
        : buildFlyingDetourPlan(state, enemy, definition, orbitTarget);
      let desiredPoint = strikerDirectChargeWindow
        ? {
            x: targetPlayer.x,
            y: clampFlyingCenterYToSafeBand(
              state,
              definition,
              clamp(
                targetPlayer.y - Math.max(34, definition.behavior.hoverHeight * 0.3),
                targetPlayer.y - Math.max(124, definition.behavior.hoverHeight * 0.82),
                targetPlayer.y + Math.max(18, definition.behavior.hoverVariance * 0.1)
              )
            ),
          }
        : orbitTarget;
      if (detourPlan) {
        const distanceToNearPoint = Math.hypot(detourPlan.nearPoint.x - enemy.x, detourPlan.nearPoint.y - enemy.y);
        const hasReachedLane = distanceToNearPoint <= 28;
        const horizontalProgress = Math.abs(enemy.x - detourPlan.farPoint.x) <= 28;
        desiredPoint = !hasReachedLane
          ? detourPlan.nearPoint
          : (!horizontalProgress ? detourPlan.farPoint : orbitTarget);
      }

      const dx = desiredPoint.x - enemy.x;
      const dy = desiredPoint.y - enemy.y;
      const horizontalDeadzone = isStrikerEnemy(definition) ? 10 : 26;
      const verticalDeadzone = isStrikerEnemy(definition) ? 12 : 18;
      const horizontalSpeedScale = isStrikerEnemy(definition)
        ? (Math.abs(dx) > 160 ? 1.55 : (Math.abs(dx) > 80 ? 1.22 : 0.92))
        : (Math.abs(dy) > 64 ? 0.74 : 1);
      const verticalSpeedScale = isStrikerEnemy(definition)
        ? (Math.abs(dy) > 90 ? 1.28 : 0.96)
        : (Math.abs(dx) > 120 ? 0.78 : 1);
      desiredVelocityX = Math.abs(dx) > horizontalDeadzone
        ? Math.sign(dx) * definition.behavior.moveSpeed * horizontalSpeedScale
        : 0;
      desiredVelocityY = Math.abs(dy) > verticalDeadzone
        ? Math.sign(dy) * definition.behavior.verticalMoveSpeed * verticalSpeedScale
        : 0;

      const flyingMoveIntent = getFlyingMovementIntent(desiredVelocityX, desiredVelocityY);
      updateEnemyProgressTracker(enemy, flyingMoveIntent, nowSec);
      const stuckDuration = getEnemyStuckDuration(enemy, flyingMoveIntent, nowSec);

      if (stuckDuration >= 0.58) {
        if (isStrikerEnemy(definition)) {
          triggerStrikerEnvironmentAttack(state, enemy, targetPlayer, nowSec);
          desiredPoint = {
            x: targetPlayer.x,
            y: clamp(
              targetPlayer.y - Math.max(definition.behavior.hoverHeight, 120),
              state.mapBounds.min_y + 64,
              targetPlayer.y - 48
            ),
          };
        } else {
          enemy.preferred_hover_offset_x *= -1;
          enemy.attack_altitude_bias = enemy.attack_altitude_bias <= 0
            ? Math.max(28, definition.behavior.hoverVariance * 0.24)
            : -definition.behavior.hoverHeight;
          detourPlan = buildFlyingDetourPlan(state, enemy, definition, getFlyingOrbitTarget(state, enemy, definition, targetPlayer, nowSec));

          if (detourPlan) {
            const prioritizeVerticalEscape = Math.abs(enemy.y - detourPlan.nearPoint.y) > 16;
            desiredPoint = prioritizeVerticalEscape
              ? { x: enemy.x, y: detourPlan.nearPoint.y }
              : detourPlan.farPoint;
          } else {
            desiredPoint = {
              x: enemy.x + (enemy.preferred_hover_offset_x > 0 ? 42 : -42),
              y: clamp(
                targetPlayer.y - definition.behavior.hoverHeight * 0.92,
                state.mapBounds.min_y + 64,
                targetPlayer.y + 36
              ),
            };
          }
        }

        const rescueDx = desiredPoint.x - enemy.x;
        const rescueDy = desiredPoint.y - enemy.y;
        desiredVelocityX = Math.abs(rescueDx) > 12
          ? Math.sign(rescueDx) * definition.behavior.moveSpeed * (isStrikerEnemy(definition) ? 1.4 : 0.78)
          : 0;
        desiredVelocityY = Math.abs(rescueDy) > 10
          ? Math.sign(rescueDy) * definition.behavior.verticalMoveSpeed * (isStrikerEnemy(definition) ? 1.32 : 1.08)
          : 0;
      }

      if (Math.abs(attackDx) > 14) {
        enemy.direction = attackDx < 0 ? 'left' : 'right';
      }
      setBrainState(
        enemy,
        Math.abs(desiredVelocityX) > 0 || Math.abs(desiredVelocityY) > 0 ? 'chase' : 'idle',
        nowSec
      );

      if (
        nowSec >= enemy.attack_cooldown_until &&
        Math.abs(targetPlayer.x - enemy.x) <= (isStrikerEnemy(definition) ? Math.max(92, definition.behavior.attackRange * 0.26) : definition.behavior.attackRange) &&
        Math.abs(targetPlayer.y - enemy.y) <= definition.behavior.hoverHeight + definition.behavior.hoverVariance + 90 &&
        !detourPlan &&
        hasLineOfSightToPlayer(state, enemy, targetPlayer)
      ) {
        beginPrepare(enemy, targetPlayer, nowSec, definition);
        desiredVelocityX = 0;
        desiredVelocityY = 0;
      }
    } else {
      navigationPlan = getCachedChaseNavigationPlan(state, enemy, definition, targetPlayer, nowSec);
      const attackDx = targetPlayer.x - enemy.x;
      moveIntent = resolveChaseMoveIntent(enemy, navigationPlan, targetPlayer, definition);
      if (moveIntent !== 0) {
        enemy.direction = moveIntent < 0 ? 'left' : 'right';
      } else if (attackDx !== 0) {
        enemy.direction = attackDx < 0 ? 'left' : 'right';
      }
      setBrainState(enemy, moveIntent === 0 ? 'idle' : 'chase', nowSec);

      if (
        enemy.on_ground &&
        nowSec >= enemy.attack_cooldown_until &&
        !navigationPlan?.pursuingPlatformFirst &&
        Math.abs(attackDx) <= definition.behavior.attackRange &&
        Math.abs(targetPlayer.y - enemy.y) <= 120
      ) {
        beginPrepare(enemy, targetPlayer, nowSec, definition);
        moveIntent = 0;
      }
    }
  } else {
    enemy.nav_cache_key = '';
    enemy.nav_cache_until = 0;
    enemy.nav_cache_plan = null;
    if (isStrikerEnemy(definition) && !canFlyingEnemyFitAt(state, definition, enemy.x, enemy.y)) {
      const ceilingEscape = getFlyingCeilingTrapEscape(state, enemy, definition);
      const rescuePoint = ceilingEscape && canFlyingEnemyFitAt(state, definition, ceilingEscape.escapeX, ceilingEscape.escapeY)
        ? { x: ceilingEscape.escapeX, y: ceilingEscape.escapeY }
        : (canFlyingEnemyFitAt(state, definition, enemy.spawn_x, enemy.spawn_y)
            ? { x: enemy.spawn_x, y: enemy.spawn_y }
            : null);
      if (rescuePoint) {
        enemy.x = rescuePoint.x;
        enemy.y = rescuePoint.y;
        enemy.vx = 0;
        enemy.vy = 0;
        enemy.knockback_vx = 0;
        enemy.jump_launch_vx = 0;
      }
    }
    if (isGargoyleEnemy(definition) && enemy.gargoyle_mode === 'perch') {
      desiredVelocityX = 0;
      desiredVelocityY = 0;
      setBrainState(enemy, 'idle', nowSec);
    } else {
    if (nowSec >= enemy.next_decision_at || Math.abs(enemy.wander_target_x - enemy.x) < 10) {
      pickWanderTarget(enemy, definition, nowSec);
      setBrainState(enemy, 'wander', nowSec);
    }

    moveIntent = Math.abs(enemy.wander_target_x - enemy.x) > 10
      ? Math.sign(enemy.wander_target_x - enemy.x)
      : 0;

    if (flying) {
      desiredVelocityX = moveIntent * definition.behavior.moveSpeed * 0.48;
      const idleTargetY = getFlyingEnemyTargetY(enemy, definition, null, nowSec);
      const dy = idleTargetY - enemy.y;
      desiredVelocityY = Math.abs(dy) > 14
        ? Math.sign(dy) * definition.behavior.verticalMoveSpeed * 0.5
        : 0;
    }

    if (moveIntent === 0) {
      setBrainState(enemy, 'idle', nowSec);
    }
    }
  }

  const strikerAttackPulseActive = isStrikerEnemy(definition) && (enemy.attack_repeat_next_at || 0) > nowSec;
  if (enemy.brain_state !== 'prepare' && enemy.brain_state !== 'lunge' && enemy.brain_state !== 'recover') {
    if (flying) {
      enemy.action = strikerAttackPulseActive
        ? 'attack'
        : (isGargoyleEnemy(definition) && enemy.gargoyle_mode === 'perch'
            ? 'idle'
            : (Math.abs(desiredVelocityX) > 0 || Math.abs(desiredVelocityY) > 0 ? 'run' : 'idle'));
    } else {
      updateEnemyProgressTracker(enemy, moveIntent, nowSec);
      maybeJumpTowardTarget(state, enemy, definition, moveIntent, targetPlayer, navigationPlan, nowSec);
      desiredVelocityX = moveIntent * definition.behavior.moveSpeed;
      enemy.action = Math.abs(desiredVelocityX) > 0 ? 'run' : 'idle';
    }
  }

  const useGroundedGargoylePhysics = isGargoyleEnemy(definition) && enemy.gargoyle_mode === 'perch';
  const useGargoyleDivePhysics = isGargoyleEnemy(definition) && enemy.gargoyle_mode === 'swoop' && enemy.brain_state === 'lunge';
  const useStrikerDivePhysics = isStrikerEnemy(definition) && enemy.brain_state === 'lunge';
  const wasOnGroundBeforePhysics = Boolean(enemy.on_ground);
  const prePhysicsVy = Number(enemy.vy) || 0;

  if (flying && !useGroundedGargoylePhysics && !useGargoyleDivePhysics && !useStrikerDivePhysics) {
    if (enemy.brain_state === 'prepare' || enemy.brain_state === 'lunge') {
      maybeRefreshFlyingAttackBias(enemy, definition, nowSec);
      const attackTargetY = getFlyingEnemyTargetY(enemy, definition, targetPlayer, nowSec);
      const dy = attackTargetY - enemy.y;
      desiredVelocityY = Math.abs(dy) > 12
        ? Math.sign(dy) * definition.behavior.verticalMoveSpeed * 0.3
        : 0;
    }
    applyFlyingEnemyPhysics(state, enemy, definition, dt, desiredVelocityX, desiredVelocityY);
  } else {
    applyEnemyPhysics(state, enemy, definition, dt, desiredVelocityX);
    maybeStickSlimeToSurface(state, enemy, definition, nowSec, input.io);
    if (isStrikerEnemy(definition) && !wasOnGroundBeforePhysics && enemy.on_ground) {
      emitStrikerGroundImpact(state, input.io, enemy, prePhysicsVy);
    }
    if (isStrikerEnemy(definition) && enemy.brain_state === 'lunge' && enemy.on_ground) {
      enemy.striker_slam_impacted_at = nowSec;
      enemy.vx = 0;
      enemy.vy = 0;
      enemy.knockback_vx = 0;
      beginRecover(enemy, nowSec);
    }
  }
  processEnemyAttackHits({
    state,
    enemy,
    definition,
    io: input.io,
    nowSec,
  });
  processStrikerTouchDamage({
    state,
    enemy,
    definition,
    io: input.io,
    nowSec,
  });
}

function updateEnemies(input) {
  if (!input.state.enemies || input.state.enemies.size === 0) {
    return;
  }

  const nowSec = Date.now() / 1000;
  for (const enemy of input.state.enemies.values()) {
    const definition = enemy.runtime_definition || getEnemyDefinition(input.state, enemy.type);
    if (!definition) {
      continue;
    }

    if (!enemy.alive) {
      updateDeadEnemy(input.state, enemy, definition, input.dt, nowSec);
      continue;
    }

    if (typeof input.shouldUpdateEnemy === 'function' && !input.shouldUpdateEnemy(enemy)) {
      enemy.vx = 0;
      enemy.vy = 0;
      enemy.knockback_vx = 0;
      enemy.knockback_vy = 0;
      continue;
    }

    if (Date.now() < (Number(enemy.spawn_protected_until_ms) || 0)) {
      enemy.vx = 0;
      enemy.vy = 0;
      enemy.knockback_vx = 0;
      enemy.knockback_vy = 0;
      enemy.action = 'idle';
      enemy.brain_state = 'idle';
      enemy.target_sid = null;
      continue;
    }

    updateAliveEnemy({
      ...input,
      enemy,
      definition,
      nowSec,
    });
  }
}

function serializeEnemiesForState(state, options = {}) {
  const payload = {};
  const nowMs = Date.now();
  const centerX = Number(options.centerX);
  const centerY = Number(options.centerY);
  const radiusX = Math.max(0, Number(options.radiusX) || 0);
  const radiusY = Math.max(0, Number(options.radiusY) || 0);
  const useViewportFilter = Number.isFinite(centerX) && Number.isFinite(centerY) && radiusX > 0 && radiusY > 0;

  for (const enemy of state.enemies.values()) {
    const definition = enemy.runtime_definition || getEnemyDefinition(state, enemy.type);
    if (!definition) {
      continue;
    }

    // Keep freshly respawned enemies fully hidden until their spawn state is finalized.
    if (nowMs < (Number(enemy.spawn_protected_until_ms) || 0)) {
      continue;
    }

    if (
      useViewportFilter &&
      (Math.abs(enemy.x - centerX) > radiusX || Math.abs(enemy.y - centerY) > radiusY)
    ) {
      continue;
    }

    payload[enemy.id] = {
      id: enemy.id,
      type: enemy.type,
      displayName: definition.displayName,
      level: Math.max(1, Math.round(Number(enemy.level) || 1)),
      x: Math.round(enemy.x * 10) / 10,
      y: Math.round(enemy.y * 10) / 10,
      vx: Math.round(enemy.vx * 10) / 10,
      vy: Math.round(enemy.vy * 10) / 10,
      on_ground: Boolean(enemy.on_ground),
      direction: enemy.direction,
      action: enemy.action,
      brain_state: enemy.brain_state,
      state_started_at_ms: Math.round((enemy.state_started_at ?? nowSec) * 1000),
      health: enemy.health,
      max_health: enemy.max_health,
      alive: enemy.alive,
      death_time_ms: enemy.death_time ? Math.round(enemy.death_time * 1000) : 0,
      despawn_at_ms: enemy.despawn_at ? Math.round(enemy.despawn_at * 1000) : 0,
      respawn_at_ms: enemy.respawn_at ? Math.round(enemy.respawn_at * 1000) : 0,
      spawn_time_ms: typeof enemy.spawn_time_ms === 'number' ? enemy.spawn_time_ms : Date.now(),
      spawn_protected_until_ms: typeof enemy.spawn_protected_until_ms === 'number' ? enemy.spawn_protected_until_ms : 0,
      target_sid: enemy.target_sid || null,
      attached_sid: enemy.attached_sid || null,
      gargoyle_mode: enemy.gargoyle_mode || null,
      stealth_broken: Boolean(enemy.stealth_broken),
      render_opacity: Number.isFinite(enemy.render_opacity) ? enemy.render_opacity : 1,
      striker_slam_impacted_at_ms: enemy.striker_slam_impacted_at
        ? Math.round(enemy.striker_slam_impacted_at * 1000)
        : 0,
    };
  }

  return payload;
}

module.exports = {
  checkFireballEnemyCollision,
  damageEnemy,
  despawnEnemiesSpawnedForPlayer,
  getEnemyHitbox,
  resetEnemiesForState,
  serializeEnemiesForState,
  syncEnemyDirector,
  updateEnemies,
};
