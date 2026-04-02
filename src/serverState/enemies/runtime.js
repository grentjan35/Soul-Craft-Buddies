const {
  GRAVITY,
  JUMP_FORCE,
  MOVE_SPEED,
  PLAYER_HITBOX_WIDTH,
  PLAYER_HITBOX_HEIGHT,
} = require('../state/constants');
const { getNearbyPlatforms } = require('../state/platformGrid/buildPlatformGrid');

function secondsFromMs(ms) {
  return ms / 1000;
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
  const definition = getEnemyDefinition(state, enemy.type);
  if (!definition) {
    return null;
  }
  return getEnemyHitboxForPosition(definition, enemy.x, enemy.y);
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
  const radius = 17;
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
    attack_hit_victims: [],
    health: definition.stats.maxHealth,
    max_health: definition.stats.maxHealth,
    alive: true,
    death_time: 0,
    despawn_at: 0,
    respawn_at: 0,
    nav_cache_key: '',
    nav_cache_until: 0,
    nav_cache_plan: null,
  };
}

function resetEnemiesForState(input) {
  const nextEnemies = new Map();
  const enemySpawns = Array.isArray(input.state.enemySpawns) ? input.state.enemySpawns : [];

  for (const spawn of enemySpawns) {
    const definition = getEnemyDefinition(input.state, spawn.type);
    if (!definition) {
      continue;
    }

    nextEnemies.set(spawn.id, buildEnemyInstance(spawn, definition));
  }

  input.state.enemies = nextEnemies;
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
  enemy.prepare_until = nowSec + secondsFromMs(definition.behavior.telegraphDurationMs);
  enemy.attack_hit_victims = [];
  enemy.vx = 0;
  enemy.jump_launch_vx = 0;
  enemy.knockback_vx = 0;
  if (targetPlayer) {
    enemy.direction = targetPlayer.x < enemy.x ? 'left' : 'right';
  }
}

function beginLunge(enemy, targetPlayer, nowSec, definition) {
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
  enemy.vy = -definition.behavior.lungeLift + Math.min(0, dirY) * 180;
  enemy.on_ground = false;
  enemy.lunge_until = nowSec + secondsFromMs(definition.behavior.lungeDurationMs);
  enemy.attack_cooldown_until = nowSec + secondsFromMs(definition.behavior.attackCooldownMs);
  enemy.attack_hit_victims = [];
}

function beginRecover(enemy, nowSec) {
  setBrainState(enemy, 'recover', nowSec);
  enemy.action = 'idle';
  enemy.recover_until = nowSec + 0.22;
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

function damagePlayerFromEnemyHit(input) {
  const { player, enemy, definition, nowSec } = input;
  if (player.is_dying) {
    return;
  }

  const directionSign = enemy.direction === 'left' ? -1 : 1;
  player.knockback_vx = directionSign * 720;
  player.vy = Math.min(player.vy, -420);
  player.on_ground = false;
  player.jumps_remaining = 0;
  player.health -= definition.stats.contactDamage;

  if (player.health <= 0) {
    player.health = 0;
    player.is_dying = true;
    player.death_time = nowSec;
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
    damage: definition.stats.contactDamage,
    health: player.health,
    is_dying: player.is_dying,
    x: enemy.x,
    y: enemy.y,
  });
}

function processEnemyAttackHits(input) {
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
    });
  }

  input.enemy.attack_hit_victims = Array.from(hitVictims);
}

function markEnemyDead(input) {
  const { enemy, definition, sourceVx, sourceVy, nowSec } = input;
  setBrainState(enemy, 'dead', nowSec);
  enemy.action = 'death';
  enemy.alive = false;
  enemy.death_time = nowSec;
  enemy.despawn_at = nowSec + secondsFromMs(definition.behavior.despawnAfterDeathMs);
  enemy.respawn_at = nowSec + secondsFromMs(definition.stats.respawnDelayMs);
  enemy.vx = 0;
  enemy.knockback_vx = Math.sign(sourceVx || (enemy.direction === 'left' ? -1 : 1)) * 260;
  enemy.vy = -Math.max(240, Math.abs(sourceVy || 0) * 0.35 + 220);
  enemy.on_ground = false;
  enemy.jumps_remaining = 0;
}

function damageEnemy(input) {
  const enemy = input.state.enemies.get(input.enemyId);
  if (!enemy || !enemy.alive) {
    return false;
  }

  const definition = getEnemyDefinition(input.state, enemy.type);
  if (!definition) {
    return false;
  }

  const nowSec = Date.now() / 1000;
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
    return true;
  }

  enemy.knockback_vx = Math.sign(input.sourceVx || (enemy.direction === 'left' ? -1 : 1)) * 140;
  enemy.vy = Math.min(enemy.vy, -180);
  return true;
}

function respawnEnemy(state, enemy, definition) {
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
  enemy.attack_hit_victims = [];
  enemy.health = definition.stats.maxHealth;
  enemy.max_health = definition.stats.maxHealth;
  enemy.alive = true;
  enemy.death_time = 0;
  enemy.despawn_at = 0;
  enemy.respawn_at = 0;
  enemy.nav_cache_key = '';
  enemy.nav_cache_until = 0;
  enemy.nav_cache_plan = null;
}

function updateDeadEnemy(state, enemy, definition, dt, nowSec) {
  if (enemy.respawn_at > 0 && nowSec >= enemy.respawn_at) {
    respawnEnemy(state, enemy, definition);
    return;
  }

  const desiredVelocityX = 0;
  applyEnemyPhysics(state, enemy, definition, dt, desiredVelocityX);
  enemy.action = 'death';
}

function updateAliveEnemy(input) {
  const { state, enemy, definition, dt, nowSec } = input;
  const targetPlayer = chooseTargetPlayer(state, enemy, definition, nowSec);
  enemy.target_sid = targetPlayer ? enemy.target_sid : null;

  let desiredVelocityX = 0;
  let moveIntent = 0;
  let navigationPlan = null;

  if (enemy.brain_state === 'prepare') {
    enemy.action = 'prepare';
    if (targetPlayer) {
      enemy.direction = targetPlayer.x < enemy.x ? 'left' : 'right';
    }
    if (nowSec >= enemy.prepare_until) {
      beginLunge(enemy, targetPlayer, nowSec, definition);
      desiredVelocityX = enemy.vx;
    }
  } else if (enemy.brain_state === 'lunge') {
    enemy.action = 'attack';
    desiredVelocityX = enemy.vx;
    if (nowSec >= enemy.lunge_until) {
      beginRecover(enemy, nowSec);
      desiredVelocityX = 0;
    }
  } else if (enemy.brain_state === 'recover') {
    enemy.action = 'idle';
    if (nowSec >= enemy.recover_until) {
      setBrainState(enemy, targetPlayer ? 'chase' : 'idle', nowSec);
    }
  } else if (targetPlayer) {
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
  } else {
    enemy.nav_cache_key = '';
    enemy.nav_cache_until = 0;
    enemy.nav_cache_plan = null;
    if (nowSec >= enemy.next_decision_at || Math.abs(enemy.wander_target_x - enemy.x) < 10) {
      pickWanderTarget(enemy, definition, nowSec);
      setBrainState(enemy, 'wander', nowSec);
    }

    moveIntent = Math.abs(enemy.wander_target_x - enemy.x) > 10
      ? Math.sign(enemy.wander_target_x - enemy.x)
      : 0;

    if (moveIntent === 0) {
      setBrainState(enemy, 'idle', nowSec);
    }
  }

  if (enemy.brain_state !== 'prepare' && enemy.brain_state !== 'lunge' && enemy.brain_state !== 'recover') {
    updateEnemyProgressTracker(enemy, moveIntent, nowSec);
    maybeJumpTowardTarget(state, enemy, definition, moveIntent, targetPlayer, navigationPlan, nowSec);
    desiredVelocityX = moveIntent * definition.behavior.moveSpeed;
    enemy.action = Math.abs(desiredVelocityX) > 0 ? 'run' : 'idle';
  }

  applyEnemyPhysics(state, enemy, definition, dt, desiredVelocityX);
  processEnemyAttackHits({
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
    const definition = getEnemyDefinition(input.state, enemy.type);
    if (!definition) {
      continue;
    }

    if (!enemy.alive) {
      updateDeadEnemy(input.state, enemy, definition, input.dt, nowSec);
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

function serializeEnemiesForState(state) {
  const payload = {};

  for (const enemy of state.enemies.values()) {
    const definition = getEnemyDefinition(state, enemy.type);
    if (!definition) {
      continue;
    }

    payload[enemy.id] = {
      id: enemy.id,
      type: enemy.type,
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
      respawn_at_ms: enemy.respawn_at ? Math.round(enemy.respawn_at * 1000) : 0,
      target_sid: enemy.target_sid || null,
    };
  }

  return payload;
}

module.exports = {
  checkFireballEnemyCollision,
  damageEnemy,
  getEnemyHitbox,
  resetEnemiesForState,
  serializeEnemiesForState,
  updateEnemies,
};
