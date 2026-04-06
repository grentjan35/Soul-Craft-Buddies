const {
  PLAYER_HITBOX_HEIGHT,
  PLAYER_HITBOX_WIDTH,
} = require('../../state/constants');

const FALLBACK_SPAWN = { x: 100, y: 500 };
const SUPPORT_EPSILON = 2;
const SPAWN_EDGE_PADDING_X = 24;
const SPAWN_EDGE_PADDING_TOP = 36;
const SPAWN_HEADROOM_HEIGHT = Math.max(24, Math.floor(PLAYER_HITBOX_HEIGHT * 0.75));

/**
 * Picks a random spawn that always has a platform beneath the player.
 * Why: players should be able to appear anywhere valid on the map, not only at fixed S1 markers.
 * @param {{state: any}} input
 * @returns {{x: number, y: number}}
 */
function pickSpawnPoint(input) {
  const platforms = Array.isArray(input.state.platforms) ? input.state.platforms : [];
  const halfW = PLAYER_HITBOX_WIDTH / 2;
  const halfH = PLAYER_HITBOX_HEIGHT / 2;
  const insetPadding = 6;
  const viablePlatforms = platforms.filter((platform) => (
    platform &&
    typeof platform.x === 'number' &&
    typeof platform.y === 'number' &&
    typeof platform.w === 'number' &&
    platform.w >= PLAYER_HITBOX_WIDTH + insetPadding * 2
  ));

  if (viablePlatforms.length > 0) {
    const platformOrder = shufflePlatforms(viablePlatforms);

    for (const platform of platformOrder) {
      const minX = platform.x + halfW + insetPadding;
      const maxX = platform.x + platform.w - halfW - insetPadding;
      const candidateXs = buildCandidateXs({ minX, maxX, fallbackX: platform.x + platform.w / 2 });

      for (const x of candidateXs) {
        const candidate = { x, y: platform.y - halfH };
        if (isSpawnPlacementValid({ state: input.state, candidate })) {
          return candidate;
        }
      }
    }
  }

  const spawnPoints = Array.isArray(input.state.spawnPoints) ? input.state.spawnPoints : [];
  if (spawnPoints.length > 0) {
    const shuffledSpawnPoints = shufflePlatforms(spawnPoints);
    for (const spawn of shuffledSpawnPoints) {
      const candidate = {
        x: typeof spawn.x === 'number' ? spawn.x : FALLBACK_SPAWN.x,
        y: typeof spawn.y === 'number' ? spawn.y : FALLBACK_SPAWN.y,
      };
      if (isSpawnPlacementValid({ state: input.state, candidate })) {
        return candidate;
      }
    }
  }

  return FALLBACK_SPAWN;
}

/**
 * Returns randomized X candidates across one platform.
 * @param {{minX: number, maxX: number, fallbackX: number}} input
 * @returns {number[]}
 */
function buildCandidateXs(input) {
  if (!(input.maxX > input.minX)) {
    return [input.fallbackX];
  }

  const candidates = [];
  const span = input.maxX - input.minX;
  const steps = 7;

  for (let index = 0; index < steps; index += 1) {
    const ratio = steps === 1 ? 0.5 : index / (steps - 1);
    candidates.push(input.minX + span * ratio);
  }

  for (let index = 0; index < 6; index += 1) {
    candidates.push(input.minX + Math.random() * span);
  }

  return shufflePlatforms(candidates);
}

/**
 * Returns true when the full player hitbox is clear and supported by a platform.
 * @param {{state: any, candidate: {x: number, y: number}}} input
 * @returns {boolean}
 */
function isSpawnPlacementValid(input) {
  const { mapBounds } = input.state;
  const halfW = PLAYER_HITBOX_WIDTH / 2;
  const halfH = PLAYER_HITBOX_HEIGHT / 2;
  const hb = {
    x: input.candidate.x - halfW,
    y: input.candidate.y - halfH,
    w: PLAYER_HITBOX_WIDTH,
    h: PLAYER_HITBOX_HEIGHT,
  };

  if (mapBounds) {
    if (hb.x < mapBounds.min_x + SPAWN_EDGE_PADDING_X) return false;
    if (hb.x + hb.w > mapBounds.max_x - SPAWN_EDGE_PADDING_X) return false;
    if (hb.y < mapBounds.min_y + SPAWN_EDGE_PADDING_TOP) return false;
    if (hb.y + hb.h > mapBounds.max_y) return false;
  }

  const platforms = Array.isArray(input.state.platforms) ? input.state.platforms : [];
  let hasSupport = false;

  for (const platform of platforms) {
    if (!platform) continue;

    const overlapsHorizontally =
      hb.x < platform.x + platform.w &&
      hb.x + hb.w > platform.x;
    const overlapsVertically =
      hb.y < platform.y + platform.h &&
      hb.y + hb.h > platform.y;

    if (overlapsHorizontally && overlapsVertically) {
      return false;
    }

    const feetAreOnTop =
      overlapsHorizontally &&
      Math.abs(hb.y + hb.h - platform.y) <= SUPPORT_EPSILON;

    if (feetAreOnTop) {
      hasSupport = true;
    }
  }

  if (!hasSupport) {
    return false;
  }

  return hasSpawnHeadroom({ platforms, hb });
}

/**
 * Returns true when there is enough empty space above the spawn.
 * @param {{platforms: any[], hb: {x:number,y:number,w:number,h:number}}} input
 * @returns {boolean}
 */
function hasSpawnHeadroom(input) {
  const headroomBox = {
    x: input.hb.x,
    y: input.hb.y - SPAWN_HEADROOM_HEIGHT,
    w: input.hb.w,
    h: SPAWN_HEADROOM_HEIGHT,
  };

  for (const platform of input.platforms) {
    if (!platform) continue;

    const overlapsHorizontally =
      headroomBox.x < platform.x + platform.w &&
      headroomBox.x + headroomBox.w > platform.x;
    const overlapsVertically =
      headroomBox.y < platform.y + platform.h &&
      headroomBox.y + headroomBox.h > platform.y;

    if (overlapsHorizontally && overlapsVertically) {
      return false;
    }
  }

  return true;
}

/**
 * Returns a shuffled copy of an array.
 * @template T
 * @param {T[]} items
 * @returns {T[]}
 */
function shufflePlatforms(items) {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    const current = copy[index];
    copy[index] = copy[swapIndex];
    copy[swapIndex] = current;
  }
  return copy;
}

module.exports = { pickSpawnPoint };
