const fs = require('fs');
const path = require('path');

const DEFAULT_FRAME_SIZE = { w: 64, h: 64 };
const DEFAULT_STATS = {
  maxHealth: 4,
  contactDamage: 25,
  respawnDelayMs: 6000,
};
const DEFAULT_BEHAVIOR = {
  movementMode: 'ground',
  attackMode: 'melee',
  detectionRadius: 320,
  leashRadius: 520,
  wanderRadius: 192,
  moveSpeed: 115,
  verticalMoveSpeed: 100,
  telegraphDurationMs: 420,
  lungeDurationMs: 520,
  attackCooldownMs: 1400,
  attackRange: 210,
  lungeSpeed: 560,
  lungeLift: 760,
  jumpForce: 720,
  stuckJumpDelayMs: 380,
  doubleJumpDelayMs: 780,
  despawnAfterDeathMs: 1400,
  hoverHeight: 112,
  hoverVariance: 84,
  hoverBobAmplitude: 16,
  hoverBobSpeed: 2.3,
  projectileSpeed: 800,
  projectileDamage: 18,
  projectileScale: 1,
  projectileRadiusScale: 1,
  projectileYOffset: 0,
  projectileOffsetX: 0,
};
const DEFAULT_ANIMATION = {
  frames: 1,
  grid: '1x1',
  asset: 'idle',
};

function toFiniteNumber(value, fallback) {
  return Number.isFinite(value) ? value : fallback;
}

function toPositiveNumber(value, fallback) {
  return value > 0 ? value : fallback;
}

function parseAnimation(rawAnimation, fallbackAsset) {
  if (!rawAnimation || typeof rawAnimation !== 'object') {
    return {
      ...DEFAULT_ANIMATION,
      asset: fallbackAsset,
    };
  }

  const frames = Math.max(1, Math.round(toFiniteNumber(Number(rawAnimation.frames), 1)));
  const grid = typeof rawAnimation.grid === 'string' && /^\d+x\d+$/i.test(rawAnimation.grid)
    ? rawAnimation.grid.toLowerCase()
    : '1x1';

  return {
    frames,
    grid,
    asset: typeof rawAnimation.asset === 'string' && rawAnimation.asset.trim()
      ? rawAnimation.asset.trim().toLowerCase()
      : fallbackAsset,
  };
}

function normalizeEnemyMetadata(rawMetadata, enemyType) {
  const safeRaw = rawMetadata && typeof rawMetadata === 'object' ? rawMetadata : {};
  const frameSize = {
    w: toPositiveNumber(Number(safeRaw.frameSize?.w), DEFAULT_FRAME_SIZE.w),
    h: toPositiveNumber(Number(safeRaw.frameSize?.h), DEFAULT_FRAME_SIZE.h),
  };

  const scale = toPositiveNumber(Number(safeRaw.scale), 0.24);

  const hitboxFromPixels = safeRaw.hitbox && typeof safeRaw.hitbox === 'object'
    ? {
        x: toFiniteNumber(Number(safeRaw.hitbox.x), frameSize.w * 0.2),
        y: toFiniteNumber(Number(safeRaw.hitbox.y), frameSize.h * 0.35),
        w: toPositiveNumber(Number(safeRaw.hitbox.w), frameSize.w * 0.6),
        h: toPositiveNumber(Number(safeRaw.hitbox.h), frameSize.h * 0.5),
      }
    : null;

  const normalizedFromRaw = safeRaw.normalized && typeof safeRaw.normalized === 'object'
    ? {
        x: toFiniteNumber(Number(safeRaw.normalized.x), 0.2),
        y: toFiniteNumber(Number(safeRaw.normalized.y), 0.35),
        w: toPositiveNumber(Number(safeRaw.normalized.w), 0.6),
        h: toPositiveNumber(Number(safeRaw.normalized.h), 0.5),
      }
    : null;

  const normalized = normalizedFromRaw ?? {
    x: hitboxFromPixels ? hitboxFromPixels.x / frameSize.w : 0.2,
    y: hitboxFromPixels ? hitboxFromPixels.y / frameSize.h : 0.35,
    w: hitboxFromPixels ? hitboxFromPixels.w / frameSize.w : 0.6,
    h: hitboxFromPixels ? hitboxFromPixels.h / frameSize.h : 0.5,
  };

  const hitbox = hitboxFromPixels ?? {
    x: Math.round(normalized.x * frameSize.w),
    y: Math.round(normalized.y * frameSize.h),
    w: Math.round(normalized.w * frameSize.w),
    h: Math.round(normalized.h * frameSize.h),
  };

  const animationSource = safeRaw.animations && typeof safeRaw.animations === 'object'
    ? safeRaw.animations
    : safeRaw;

  const attackAnimation = parseAnimation(animationSource.attack, 'attack');
  const animations = {
    idle: parseAnimation(animationSource.idle, 'idle'),
    run: parseAnimation(animationSource.run, 'run'),
    attack: attackAnimation,
    death: parseAnimation(animationSource.death, 'death'),
    prepare: parseAnimation(
      animationSource.prepare ?? {
        ...attackAnimation,
        frames: Math.min(4, attackAnimation.frames),
      },
      attackAnimation.asset || 'attack'
    ),
  };

  return {
    id: enemyType,
    type: enemyType,
    displayName: typeof safeRaw.displayName === 'string' && safeRaw.displayName.trim()
      ? safeRaw.displayName.trim()
      : enemyType.charAt(0).toUpperCase() + enemyType.slice(1),
    scale,
    frameSize,
    hitbox,
    normalized,
    stats: {
      ...DEFAULT_STATS,
      ...(safeRaw.stats && typeof safeRaw.stats === 'object' ? safeRaw.stats : {}),
      maxHealth: Math.max(1, Math.round(toFiniteNumber(Number(safeRaw.stats?.maxHealth), DEFAULT_STATS.maxHealth))),
      contactDamage: Math.max(1, Math.round(toFiniteNumber(Number(safeRaw.stats?.contactDamage), DEFAULT_STATS.contactDamage))),
      respawnDelayMs: Math.max(1000, Math.round(toFiniteNumber(Number(safeRaw.stats?.respawnDelayMs), DEFAULT_STATS.respawnDelayMs))),
    },
    behavior: {
      ...DEFAULT_BEHAVIOR,
      ...(safeRaw.behavior && typeof safeRaw.behavior === 'object' ? safeRaw.behavior : {}),
      movementMode:
        typeof safeRaw.behavior?.movementMode === 'string' && safeRaw.behavior.movementMode.trim()
          ? safeRaw.behavior.movementMode.trim().toLowerCase()
          : DEFAULT_BEHAVIOR.movementMode,
      attackMode:
        typeof safeRaw.behavior?.attackMode === 'string' && safeRaw.behavior.attackMode.trim()
          ? safeRaw.behavior.attackMode.trim().toLowerCase()
          : DEFAULT_BEHAVIOR.attackMode,
      detectionRadius: toPositiveNumber(Number(safeRaw.behavior?.detectionRadius), DEFAULT_BEHAVIOR.detectionRadius),
      leashRadius: toPositiveNumber(Number(safeRaw.behavior?.leashRadius), DEFAULT_BEHAVIOR.leashRadius),
      wanderRadius: toPositiveNumber(Number(safeRaw.behavior?.wanderRadius), DEFAULT_BEHAVIOR.wanderRadius),
      moveSpeed: toPositiveNumber(Number(safeRaw.behavior?.moveSpeed), DEFAULT_BEHAVIOR.moveSpeed),
      verticalMoveSpeed: toPositiveNumber(Number(safeRaw.behavior?.verticalMoveSpeed), DEFAULT_BEHAVIOR.verticalMoveSpeed),
      telegraphDurationMs: toPositiveNumber(Number(safeRaw.behavior?.telegraphDurationMs), DEFAULT_BEHAVIOR.telegraphDurationMs),
      lungeDurationMs: toPositiveNumber(Number(safeRaw.behavior?.lungeDurationMs), DEFAULT_BEHAVIOR.lungeDurationMs),
      attackCooldownMs: toPositiveNumber(Number(safeRaw.behavior?.attackCooldownMs), DEFAULT_BEHAVIOR.attackCooldownMs),
      attackRange: toPositiveNumber(Number(safeRaw.behavior?.attackRange), DEFAULT_BEHAVIOR.attackRange),
      lungeSpeed: toPositiveNumber(Number(safeRaw.behavior?.lungeSpeed), DEFAULT_BEHAVIOR.lungeSpeed),
      lungeLift: toPositiveNumber(Number(safeRaw.behavior?.lungeLift), DEFAULT_BEHAVIOR.lungeLift),
      jumpForce: toPositiveNumber(Number(safeRaw.behavior?.jumpForce), DEFAULT_BEHAVIOR.jumpForce),
      stuckJumpDelayMs: toPositiveNumber(Number(safeRaw.behavior?.stuckJumpDelayMs), DEFAULT_BEHAVIOR.stuckJumpDelayMs),
      doubleJumpDelayMs: toPositiveNumber(Number(safeRaw.behavior?.doubleJumpDelayMs), DEFAULT_BEHAVIOR.doubleJumpDelayMs),
      despawnAfterDeathMs: toPositiveNumber(Number(safeRaw.behavior?.despawnAfterDeathMs), DEFAULT_BEHAVIOR.despawnAfterDeathMs),
      hoverHeight: toPositiveNumber(Number(safeRaw.behavior?.hoverHeight), DEFAULT_BEHAVIOR.hoverHeight),
      hoverVariance: toPositiveNumber(Number(safeRaw.behavior?.hoverVariance), DEFAULT_BEHAVIOR.hoverVariance),
      hoverBobAmplitude: toPositiveNumber(Number(safeRaw.behavior?.hoverBobAmplitude), DEFAULT_BEHAVIOR.hoverBobAmplitude),
      hoverBobSpeed: toPositiveNumber(Number(safeRaw.behavior?.hoverBobSpeed), DEFAULT_BEHAVIOR.hoverBobSpeed),
      projectileSpeed: toPositiveNumber(Number(safeRaw.behavior?.projectileSpeed), DEFAULT_BEHAVIOR.projectileSpeed),
      projectileDamage: toPositiveNumber(Number(safeRaw.behavior?.projectileDamage), DEFAULT_BEHAVIOR.projectileDamage),
      projectileScale: toPositiveNumber(Number(safeRaw.behavior?.projectileScale), DEFAULT_BEHAVIOR.projectileScale),
      projectileRadiusScale: toPositiveNumber(Number(safeRaw.behavior?.projectileRadiusScale), DEFAULT_BEHAVIOR.projectileRadiusScale),
      projectileYOffset: toFiniteNumber(Number(safeRaw.behavior?.projectileYOffset), DEFAULT_BEHAVIOR.projectileYOffset),
      projectileOffsetX: toFiniteNumber(Number(safeRaw.behavior?.projectileOffsetX), DEFAULT_BEHAVIOR.projectileOffsetX),
    },
    animations,
  };
}

function getEnemyMetadataPath(input) {
  return path.join(input.staticDir, 'assets', 'enemies', input.enemyType, `metadata_${input.enemyType}.json`);
}

function loadEnemyMetadata(input) {
  const metadataPath = getEnemyMetadataPath(input);
  if (!fs.existsSync(metadataPath)) {
    return null;
  }

  const raw = fs.readFileSync(metadataPath, 'utf8');
  return normalizeEnemyMetadata(JSON.parse(raw), input.enemyType);
}

function loadEnemyCatalog(input) {
  const enemiesDir = path.join(input.staticDir, 'assets', 'enemies');
  let entries = [];

  try {
    entries = fs.readdirSync(enemiesDir, { withFileTypes: true });
  } catch {
    return {};
  }

  const catalog = {};
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const enemyType = entry.name.trim().toLowerCase();
    try {
      const metadata = loadEnemyMetadata({ staticDir: input.staticDir, enemyType });
      if (metadata) {
        catalog[enemyType] = metadata;
      }
    } catch {
      // Skip malformed enemy folders so one bad file does not break the server.
    }
  }

  return catalog;
}

function saveEnemyMetadata(input) {
  const normalized = normalizeEnemyMetadata(input.metadata, input.enemyType);
  const metadataPath = getEnemyMetadataPath(input);
  fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
  fs.writeFileSync(metadataPath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return normalized;
}

function normalizeEnemySpawn(rawSpawn, index, enemyCatalog = null) {
  if (!rawSpawn || typeof rawSpawn !== 'object') {
    return null;
  }

  const type = String(rawSpawn.type ?? rawSpawn.enemyType ?? '').trim().toLowerCase();
  if (!type) {
    return null;
  }
  if (enemyCatalog && !enemyCatalog[type]) {
    return null;
  }

  const x = Number(rawSpawn.x);
  const y = Number(rawSpawn.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  const fallbackId = `${type}_${index}`;
  return {
    id: String(rawSpawn.id ?? fallbackId),
    type,
    x,
    y,
  };
}

function normalizeEnemySpawns(rawSpawns, enemyCatalog = null) {
  if (!Array.isArray(rawSpawns)) {
    return [];
  }

  const seenIds = new Set();
  const normalized = [];

  rawSpawns.forEach((rawSpawn, index) => {
    const spawn = normalizeEnemySpawn(rawSpawn, index, enemyCatalog);
    if (!spawn) {
      return;
    }

    let nextId = spawn.id;
    let suffix = 1;
    while (seenIds.has(nextId)) {
      nextId = `${spawn.id}_${suffix}`;
      suffix += 1;
    }

    seenIds.add(nextId);
    normalized.push({
      ...spawn,
      id: nextId,
    });
  });

  return normalized;
}

module.exports = {
  loadEnemyCatalog,
  loadEnemyMetadata,
  normalizeEnemyMetadata,
  normalizeEnemySpawns,
  saveEnemyMetadata,
};
