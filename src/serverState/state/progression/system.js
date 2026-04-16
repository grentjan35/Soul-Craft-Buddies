const { PLAYER_MAX_HEALTH } = require('../constants');

const CARD_RARITY_ORDER = ['common', 'uncommon', 'rare', 'epic', 'legendary'];

const CARD_RARITY_META = {
  common: { label: 'Common', weight: 110, accent: '#d7c9a6', glow: 'rgba(255, 223, 163, 0.34)' },
  uncommon: { label: 'Uncommon', weight: 80, accent: '#65d39b', glow: 'rgba(92, 248, 168, 0.3)' },
  rare: { label: 'Rare', weight: 52, accent: '#58a7ff', glow: 'rgba(80, 158, 255, 0.34)' },
  epic: { label: 'Epic', weight: 30, accent: '#d06cff', glow: 'rgba(206, 108, 255, 0.38)' },
  legendary: { label: 'Legendary', weight: 14, accent: '#ffb347', glow: 'rgba(255, 189, 88, 0.44)' },
};

const BASE_PLAYER_RUN_STATS = Object.freeze({
  maxHealth: PLAYER_MAX_HEALTH,
  moveSpeed: 235,
  jumpVelocity: -650,
  damageReduction: 0,
  xpGainMultiplier: 1,
  soulMagnetMultiplier: 1,
  soulHealMultiplier: 1,
  regainPerSecond: 0.5,
  fireballDamage: 12,
  fireballExplosionRadius: 20,
  fireballExplosionDamageMultiplier: 1,
  fireballCritChance: 0.02,
  fireballCritMultiplier: 1.45,
  fireballProjectileCount: 1,
  fireballProjectileSpreadDeg: 6,
  fireballRange: 960,
  fireballSpeedMultiplier: 0.74,
  fireballRenderScale: 0.54,
  fireballRadiusScale: 0.52,
  fireballGravityScale: 1.34,
  attackDuration: 0.92,
});

const ACHIEVEMENT_RULES = Object.freeze([
  {
    id: 'jump_25',
    metric: 'jumps',
    threshold: 25,
    title: 'Restless Feet',
    message: 'You have leapt 25 times. The world is starting to notice.',
  },
  {
    id: 'jump_100',
    metric: 'jumps',
    threshold: 100,
    title: 'Sky Drifter',
    message: 'You have leapt 100 times. Even gravity is offended.',
  },
  {
    id: 'enemy_kills_10',
    metric: 'enemyKills',
    threshold: 10,
    title: 'Soul Reaper',
    message: 'You have slain 10 enemies.',
  },
  {
    id: 'enemy_kills_40',
    metric: 'enemyKills',
    threshold: 40,
    title: 'Crowd Cleaver',
    message: 'You have slain 40 enemies.',
  },
  {
    id: 'souls_25',
    metric: 'soulsCollected',
    threshold: 25,
    title: 'Soul Tender',
    message: 'You have gathered 25 souls.',
  },
  {
    id: 'souls_100',
    metric: 'soulsCollected',
    threshold: 100,
    title: 'Soul Hoarder',
    message: 'You have gathered 100 souls.',
  },
  {
    id: 'player_kills_3',
    metric: 'playerKills',
    threshold: 3,
    title: 'Duel Hunger',
    message: 'You have felled 3 rival soul crafters.',
  },
]);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getXpRequiredForLevel(level) {
  return Math.round(14 + Math.pow(Math.max(0, level - 1), 1.1) * 7);
}

function rarityForTier(tierIndex) {
  if (tierIndex <= 0) return 'common';
  if (tierIndex === 1) return 'uncommon';
  if (tierIndex === 2) return 'rare';
  if (tierIndex === 3) return 'epic';
  return 'legendary';
}

function tierRoman(index) {
  return ['I', 'II', 'III', 'IV', 'V', 'VI'][index] || String(index + 1);
}

function percentLabel(value, decimals = 0) {
  const scaled = Number((value * 100).toFixed(decimals));
  return `${scaled > 0 ? '+' : ''}${scaled}%`;
}

function flatLabel(value) {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded > 0 ? '+' : ''}${rounded}`;
}

function createFamilyDefinition(config) {
  return { ...config, cards: [] };
}

function buildUpgradeCatalog() {
  const families = [
    createFamilyDefinition({
      family: 'fireball_damage',
      name: 'Ember Might',
      category: 'fireball',
      art: 'fireball',
      values: [0.08, 0.1, 0.12, 0.16, 0.22, 0.28],
      apply: (stats, value) => { stats.fireballDamage *= 1 + value; },
      describe: (value) => `Fireball damage ${percentLabel(value)}.`,
    }),
    createFamilyDefinition({
      family: 'fireball_radius',
      name: 'Blast Bloom',
      category: 'fireball',
      art: 'explosion',
      values: [0.06, 0.08, 0.1, 0.14, 0.18, 0.24],
      apply: (stats, value) => { stats.fireballExplosionRadius *= 1 + value; },
      describe: (value) => `Explosion radius ${percentLabel(value)}.`,
    }),
    createFamilyDefinition({
      family: 'fireball_size',
      name: 'Cinder Mass',
      category: 'fireball',
      art: 'meteor',
      values: [0.05, 0.06, 0.08, 0.1, 0.12, 0.15],
      apply: (stats, value) => {
        stats.fireballRenderScale *= 1 + value;
        stats.fireballRadiusScale *= 1 + value;
      },
      describe: (value) => `Fireball body size ${percentLabel(value)}.`,
    }),
    createFamilyDefinition({
      family: 'fireball_range',
      name: 'Long Cast',
      category: 'fireball',
      art: 'range',
      values: [0.08, 0.1, 0.12, 0.16, 0.2, 0.26],
      apply: (stats, value) => { stats.fireballRange *= 1 + value; },
      describe: (value) => `Fireball travel range ${percentLabel(value)}.`,
    }),
    createFamilyDefinition({
      family: 'fireball_speed',
      name: 'Flaring Velocity',
      category: 'fireball',
      art: 'wind',
      values: [0.06, 0.08, 0.1, 0.13, 0.17, 0.22],
      apply: (stats, value) => { stats.fireballSpeedMultiplier *= 1 + value; },
      describe: (value) => `Fireball launch speed ${percentLabel(value)}.`,
    }),
    createFamilyDefinition({
      family: 'fireball_reload',
      name: 'Quickened Sigil',
      category: 'fireball',
      art: 'clock',
      values: [0.06, 0.08, 0.1, 0.12, 0.15, 0.18],
      apply: (stats, value) => { stats.attackDuration *= 1 - value; },
      describe: (value) => `Cast time ${percentLabel(-value)} faster.`,
    }),
    createFamilyDefinition({
      family: 'fireball_crit',
      name: 'Ashen Insight',
      category: 'fireball',
      art: 'crit',
      values: [0.03, 0.035, 0.04, 0.05, 0.06, 0.075],
      apply: (stats, value) => { stats.fireballCritChance += value; },
      describe: (value) => `Critical chance ${percentLabel(value)}.`,
    }),
    createFamilyDefinition({
      family: 'fireball_crit_damage',
      name: 'Pyre Verdict',
      category: 'fireball',
      art: 'crit',
      values: [0.12, 0.14, 0.16, 0.2, 0.24, 0.3],
      apply: (stats, value) => { stats.fireballCritMultiplier += value; },
      describe: (value) => `Critical damage ${percentLabel(value)}.`,
    }),
    createFamilyDefinition({
      family: 'fireball_multishot',
      name: 'Twin Pyre',
      category: 'fireball',
      art: 'multishot',
      values: [1, 1, 1, 1, 1, 1],
      apply: (stats, value, tierIndex) => {
        stats.fireballProjectileCount += value;
        stats.fireballProjectileSpreadDeg = Math.min(28, stats.fireballProjectileSpreadDeg + 1.5 + tierIndex * 0.8);
      },
      describe: (_value, tierIndex) => `Launch ${tierIndex >= 3 ? 'an extra blazing shard' : 'another fireball'} per cast.`,
      minLevel: [2, 4, 6, 9, 12, 16],
    }),
    createFamilyDefinition({
      family: 'fireball_splash_damage',
      name: 'Inferno Core',
      category: 'fireball',
      art: 'explosion',
      values: [0.06, 0.08, 0.1, 0.12, 0.16, 0.2],
      apply: (stats, value) => { stats.fireballExplosionDamageMultiplier *= 1 + value; },
      describe: (value) => `Explosion damage ${percentLabel(value)}.`,
    }),
    createFamilyDefinition({
      family: 'fireball_gravity',
      name: 'Steady Flame',
      category: 'fireball',
      art: 'arc',
      values: [0.06, 0.08, 0.1, 0.12, 0.15, 0.18],
      apply: (stats, value) => { stats.fireballGravityScale *= 1 - value; },
      describe: (value) => `Fireballs arc ${percentLabel(-value)} less.`,
    }),
    createFamilyDefinition({
      family: 'xp_gain',
      name: 'Scholar of Ash',
      category: 'utility',
      art: 'xp',
      values: [0.08, 0.1, 0.12, 0.15, 0.18, 0.22],
      apply: (stats, value) => { stats.xpGainMultiplier *= 1 + value; },
      describe: (value) => `Gain XP ${percentLabel(value)} faster.`,
    }),
    createFamilyDefinition({
      family: 'move_speed',
      name: 'Wayfarer Step',
      category: 'movement',
      art: 'boots',
      values: [0.05, 0.06, 0.07, 0.09, 0.11, 0.14],
      apply: (stats, value) => { stats.moveSpeed *= 1 + value; },
      describe: (value) => `Move speed ${percentLabel(value)}.`,
    }),
    createFamilyDefinition({
      family: 'jump_power',
      name: 'Skybound Anklet',
      category: 'movement',
      art: 'wing',
      values: [0.05, 0.06, 0.07, 0.09, 0.11, 0.14],
      apply: (stats, value) => { stats.jumpVelocity *= 1 + value; },
      describe: (value) => `Jump height ${percentLabel(value)}.`,
    }),
    createFamilyDefinition({
      family: 'max_health',
      name: 'Crimson Vessel',
      category: 'survival',
      art: 'heart',
      values: [8, 10, 12, 15, 18, 24],
      apply: (stats, value) => { stats.maxHealth += value; },
      describe: (value) => `Max health ${flatLabel(value)}.`,
    }),
    createFamilyDefinition({
      family: 'damage_reduction',
      name: 'Iron Prayer',
      category: 'survival',
      art: 'shield',
      values: [0.03, 0.035, 0.04, 0.045, 0.055, 0.065],
      apply: (stats, value) => { stats.damageReduction += value; },
      describe: (value) => `Damage taken ${percentLabel(-value)}.`,
      minLevel: [1, 3, 5, 8, 11, 14],
    }),
    createFamilyDefinition({
      family: 'soul_magnet',
      name: 'Spirit Magnet',
      category: 'utility',
      art: 'soul',
      values: [0.08, 0.1, 0.12, 0.15, 0.18, 0.22],
      apply: (stats, value) => { stats.soulMagnetMultiplier *= 1 + value; },
      describe: (value) => `Soul pickup reach ${percentLabel(value)}.`,
    }),
    createFamilyDefinition({
      family: 'soul_heal',
      name: 'Kindled Recovery',
      category: 'survival',
      art: 'potion',
      values: [0.08, 0.1, 0.12, 0.15, 0.18, 0.22],
      apply: (stats, value) => { stats.soulHealMultiplier *= 1 + value; },
      describe: (value) => `Soul healing ${percentLabel(value)}.`,
    }),
    createFamilyDefinition({
      family: 'regain',
      name: 'Regen',
      category: 'survival',
      art: 'heart',
      values: [0.12, 0.18, 0.26, 0.35, 0.48, 0.65],
      apply: (stats, value) => { stats.regainPerSecond += value; },
      describe: (value) => `Regen ${flatLabel(value)} HP per second.`,
    }),
  ];

  const allCards = [];
  for (const family of families) {
    for (let tierIndex = 0; tierIndex < family.values.length; tierIndex += 1) {
      const rarity = rarityForTier(tierIndex);
      const rarityMeta = CARD_RARITY_META[rarity];
      const value = family.values[tierIndex];
      const minLevel = Array.isArray(family.minLevel)
        ? family.minLevel[tierIndex]
        : Math.max(1, 1 + tierIndex * 2);
      const card = {
        id: `${family.family}_${tierIndex + 1}`,
        family: family.family,
        category: family.category,
        title: `${family.name} ${tierRoman(tierIndex)}`,
        description: family.describe(value, tierIndex),
        rarity,
        rarityLabel: rarityMeta.label,
        accent: rarityMeta.accent,
        glow: rarityMeta.glow,
        art: family.art,
        tier: tierIndex + 1,
        minLevel,
        weight: Math.max(4, rarityMeta.weight - tierIndex * 3),
        value,
        applyStats(stats) {
          family.apply(stats, value, tierIndex);
        },
      };
      family.cards.push(card);
      allCards.push(card);
    }
  }

  return { families, allCards };
}

const UPGRADE_CATALOG = buildUpgradeCatalog();

function cloneBaseStats() {
  return JSON.parse(JSON.stringify(BASE_PLAYER_RUN_STATS));
}

function createProgressionMeta() {
  return {
    metrics: {
      jumps: 0,
      enemyKills: 0,
      playerKills: 0,
      soulsCollected: 0,
    },
    achievements: {},
    achievementOrder: [],
    unreadAchievementIds: [],
    claimedAchievementIds: [],
    flags: {
      enemyAggroUnlocked: false,
    },
  };
}

function createPlayerProgression() {
  return {
    level: 1,
    xp: 0,
    xpToNext: getXpRequiredForLevel(1),
    pendingLevelUps: 0,
    pendingChoices: null,
    selectedCards: [],
    upgradeLevels: {},
    runStats: cloneBaseStats(),
    meta: createProgressionMeta(),
  };
}

function resetPlayerProgression(player) {
  // Preserve achievements when resetting progression on death
  const existingMeta = player.progression?.meta;
  const preservedAchievements = existingMeta?.achievements || {};
  const preservedAchievementOrder = existingMeta?.achievementOrder || [];
  const preservedUnreadAchievementIds = existingMeta?.unreadAchievementIds || [];

  player.progression = createPlayerProgression();

  // Restore achievements
  if (player.progression.meta) {
    player.progression.meta.achievements = preservedAchievements;
    player.progression.meta.achievementOrder = preservedAchievementOrder;
    player.progression.meta.unreadAchievementIds = preservedUnreadAchievementIds;
  }

  player.health = Math.min(player.health ?? player.progression.runStats.maxHealth, player.progression.runStats.maxHealth);
}

function ensurePlayerProgression(player) {
  if (!player.progression) {
    player.progression = createPlayerProgression();
  }
  if (!player.progression.runStats) {
    player.progression.runStats = cloneBaseStats();
  }
  if (!player.progression.upgradeLevels) {
    player.progression.upgradeLevels = {};
  }
  if (!Array.isArray(player.progression.selectedCards)) {
    player.progression.selectedCards = [];
  }
  if (!Number.isFinite(player.progression.xpToNext)) {
    player.progression.xpToNext = getXpRequiredForLevel(player.progression.level || 1);
  }
  if (!player.progression.meta || typeof player.progression.meta !== 'object') {
    player.progression.meta = createProgressionMeta();
  }
  if (!player.progression.meta.metrics || typeof player.progression.meta.metrics !== 'object') {
    player.progression.meta.metrics = createProgressionMeta().metrics;
  }
  if (!player.progression.meta.achievements || typeof player.progression.meta.achievements !== 'object') {
    player.progression.meta.achievements = {};
  }
  if (!Array.isArray(player.progression.meta.achievementOrder)) {
    player.progression.meta.achievementOrder = [];
  }
  if (!Array.isArray(player.progression.meta.unreadAchievementIds)) {
    player.progression.meta.unreadAchievementIds = [];
  }
  if (!Array.isArray(player.progression.meta.claimedAchievementIds)) {
    player.progression.meta.claimedAchievementIds = [];
  }
  if (!player.progression.meta.flags || typeof player.progression.meta.flags !== 'object') {
    player.progression.meta.flags = createProgressionMeta().flags;
  }
  return player.progression;
}

function getPlayerRunStats(player) {
  return ensurePlayerProgression(player).runStats;
}

function getCurrentCardForFamily(progression, family) {
  const currentRank = progression.upgradeLevels[family.family] || 0;
  return family.cards[currentRank] || null;
}

function levelWeightBonus(level, rarity) {
  const orderIndex = CARD_RARITY_ORDER.indexOf(rarity);
  if (orderIndex <= 0) {
    return 1;
  }
  const unlockLevel = 1 + orderIndex * 3;
  if (level < unlockLevel) {
    return 0;
  }
  return 1 + Math.min(1.45, (level - unlockLevel) * 0.08);
}

function pickWeightedCards(pool, count) {
  const choices = [];
  const candidates = pool.slice();

  while (choices.length < count && candidates.length > 0) {
    const totalWeight = candidates.reduce((sum, candidate) => sum + Math.max(0, candidate.rollWeight || 0), 0);
    if (totalWeight <= 0) {
      choices.push(candidates.shift());
      continue;
    }

    let roll = Math.random() * totalWeight;
    let selectedIndex = 0;
    for (let i = 0; i < candidates.length; i += 1) {
      roll -= Math.max(0, candidates[i].rollWeight || 0);
      if (roll <= 0) {
        selectedIndex = i;
        break;
      }
    }
    choices.push(candidates.splice(selectedIndex, 1)[0]);
  }

  return choices;
}

function rollUpgradeChoices(player) {
  const progression = ensurePlayerProgression(player);
  const pool = [];

  for (const family of UPGRADE_CATALOG.families) {
    const card = getCurrentCardForFamily(progression, family);
    if (!card) {
      continue;
    }
    if (progression.level < card.minLevel) {
      continue;
    }

    pool.push({
      ...card,
      rollWeight: card.weight * levelWeightBonus(progression.level, card.rarity),
    });
  }

  const picked = pickWeightedCards(pool, Math.min(3, pool.length)).map((card) => serializeCard(card));
  progression.pendingChoices = picked.length > 0 ? picked : null;
  return progression.pendingChoices;
}

function maybeQueueLevelUpChoices(player) {
  const progression = ensurePlayerProgression(player);
  if (progression.pendingChoices || progression.pendingLevelUps <= 0) {
    return progression.pendingChoices;
  }
  return rollUpgradeChoices(player);
}

function serializeCard(card) {
  return {
    id: card.id,
    family: card.family,
    category: card.category,
    title: card.title,
    description: card.description,
    rarity: card.rarity,
    rarityLabel: card.rarityLabel,
    accent: card.accent,
    glow: card.glow,
    art: card.art,
    tier: card.tier,
  };
}

function gainPlayerXp(player, amount) {
  const progression = ensurePlayerProgression(player);
  const runStats = getPlayerRunStats(player);
  const scaledAmount = Math.max(0, Math.round((Number(amount) || 0) * (runStats.xpGainMultiplier || 1)));
  if (scaledAmount <= 0) {
    return { gainedXp: 0, leveled: false };
  }

  progression.xp += scaledAmount;
  let leveled = false;
  while (progression.xp >= progression.xpToNext) {
    progression.xp -= progression.xpToNext;
    progression.level += 1;
    progression.pendingLevelUps += 1;
    progression.xpToNext = getXpRequiredForLevel(progression.level);
    leveled = true;
  }

  if (leveled) {
    maybeQueueLevelUpChoices(player);
  }
  return { gainedXp: scaledAmount, leveled };
}

function recordProgressionMetric(player, metric, amount = 1) {
  const progression = ensurePlayerProgression(player);
  const metrics = progression.meta.metrics;
  const nextAmount = Math.max(0, Number(amount) || 0);
  if (!Object.prototype.hasOwnProperty.call(metrics, metric) || nextAmount <= 0) {
    return [];
  }

  metrics[metric] = Math.max(0, Math.round(Number(metrics[metric]) || 0)) + nextAmount;
  const unlocked = [];

  for (const rule of ACHIEVEMENT_RULES) {
    if (rule.metric !== metric) {
      continue;
    }
    if (progression.meta.achievements[rule.id]) {
      continue;
    }
    if (metrics[metric] < rule.threshold) {
      continue;
    }

    progression.meta.achievements[rule.id] = true;
    progression.meta.achievementOrder.push(rule.id);
    if (!progression.meta.unreadAchievementIds.includes(rule.id)) {
      progression.meta.unreadAchievementIds.push(rule.id);
    }
    unlocked.push({
      id: rule.id,
      title: rule.title,
      message: rule.message,
      type: 'achievement',
      xp: 0,
      caption: 'Achievement Unlocked',
    });
  }

  return unlocked;
}

function markAchievementsRead(player) {
  const progression = ensurePlayerProgression(player);
  progression.meta.unreadAchievementIds = [];
}

function getAchievementRewardXp(rule) {
  return Math.max(12, Math.round((Number(rule?.threshold) || 0) * 0.7));
}

function collectAchievementReward(player, achievementId) {
  const progression = ensurePlayerProgression(player);
  const rule = ACHIEVEMENT_RULES.find((entry) => entry.id === achievementId);
  if (!rule) {
    return { ok: false, reason: 'Achievement missing' };
  }
  if (!progression.meta.achievements[achievementId]) {
    return { ok: false, reason: 'Achievement not unlocked' };
  }
  if (progression.meta.claimedAchievementIds.includes(achievementId)) {
    return { ok: false, reason: 'Reward already claimed' };
  }

  progression.meta.claimedAchievementIds.push(achievementId);
  const rewardXp = getAchievementRewardXp(rule);
  const xpResult = gainPlayerXp(player, rewardXp);
  return {
    ok: true,
    rewardXp,
    gainedXp: xpResult.gainedXp,
    leveled: xpResult.leveled,
    achievement: {
      id: rule.id,
      title: rule.title,
      message: rule.message,
    },
  };
}

function consumeAggroUnlockNotification(player) {
  const progression = ensurePlayerProgression(player);
  if (progression.level <= 5 || progression.meta.flags.enemyAggroUnlocked) {
    return null;
  }

  progression.meta.flags.enemyAggroUnlocked = true;
  return {
    type: 'danger',
    title: '',
    message: 'Enemies will now attack you.',
    xp: 0,
    caption: 'Danger Rising',
  };
}

function getPlayerLevel(player) {
  return Math.max(1, Math.round(Number(ensurePlayerProgression(player).level) || 1));
}

function findCardById(cardId) {
  return UPGRADE_CATALOG.allCards.find((card) => card.id === cardId) || null;
}

function clampPlayerHealthToMax(player, healDelta = 0) {
  const stats = getPlayerRunStats(player);
  const maxHealth = Math.max(1, Math.round(stats.maxHealth));
  player.health = Math.max(0, Math.min(maxHealth, (player.health || 0) + healDelta));
  return maxHealth;
}

function applyUpgradeSelection(player, cardId) {
  const progression = ensurePlayerProgression(player);
  if (!Array.isArray(progression.pendingChoices) || progression.pendingChoices.length === 0) {
    return { ok: false, reason: 'No pending choices' };
  }

  const selectedCard = progression.pendingChoices.find((card) => card.id === cardId);
  if (!selectedCard) {
    return { ok: false, reason: 'Card unavailable' };
  }

  const card = findCardById(cardId);
  if (!card) {
    return { ok: false, reason: 'Card missing' };
  }

  const previousMaxHealth = progression.runStats.maxHealth;
  card.applyStats(progression.runStats);
  progression.runStats.damageReduction = clamp(progression.runStats.damageReduction, 0, 0.72);
  progression.runStats.fireballCritChance = clamp(progression.runStats.fireballCritChance, 0, 0.85);
  progression.runStats.attackDuration = Math.max(0.24, progression.runStats.attackDuration);
  progression.runStats.fireballGravityScale = Math.max(0.25, progression.runStats.fireballGravityScale);
  progression.runStats.fireballProjectileCount = Math.max(1, Math.round(progression.runStats.fireballProjectileCount));
  progression.runStats.regainPerSecond = Math.max(0, progression.runStats.regainPerSecond);
  progression.upgradeLevels[card.family] = (progression.upgradeLevels[card.family] || 0) + 1;
  progression.selectedCards.push({
    id: card.id,
    title: card.title,
    rarity: card.rarity,
    tier: card.tier,
  });

  progression.pendingChoices = null;
  progression.pendingLevelUps = Math.max(0, progression.pendingLevelUps - 1);

  const newMaxHealth = Math.max(1, Math.round(progression.runStats.maxHealth));
  const healDelta = newMaxHealth > previousMaxHealth ? newMaxHealth - previousMaxHealth : 0;
  clampPlayerHealthToMax(player, healDelta);
  maybeQueueLevelUpChoices(player);

  return {
    ok: true,
    card: serializeCard(card),
  };
}

function getPlayerProgressionPayload(player) {
  const progression = ensurePlayerProgression(player);
  const achievements = progression.meta.achievementOrder
    .map((achievementId) => {
      const rule = ACHIEVEMENT_RULES.find((entry) => entry.id === achievementId);
      if (!rule) {
        return null;
      }
      return {
        id: rule.id,
        title: rule.title,
        message: rule.message,
        metric: rule.metric,
        threshold: rule.threshold,
        unread: progression.meta.unreadAchievementIds.includes(rule.id),
        claimed: progression.meta.claimedAchievementIds.includes(rule.id),
        rewardXp: getAchievementRewardXp(rule),
      };
    })
    .filter(Boolean);
  return {
    level: progression.level,
    xp: progression.xp,
    xpToNext: progression.xpToNext,
    pendingLevelUps: progression.pendingLevelUps,
    pendingChoices: progression.pendingChoices,
    selectedCards: progression.selectedCards.slice(-12),
    totalCards: progression.selectedCards.length,
    achievements: achievements.slice(-20),
    unreadAchievementCount: progression.meta.unreadAchievementIds.length,
    runStats: {
      ...progression.runStats,
    },
  };
}

function isPlayerDrafting(player) {
  const progression = ensurePlayerProgression(player);
  return Array.isArray(progression.pendingChoices) && progression.pendingChoices.length > 0;
}

module.exports = {
  ACHIEVEMENT_RULES,
  BASE_PLAYER_RUN_STATS,
  CARD_RARITY_META,
  UPGRADE_CATALOG,
  applyUpgradeSelection,
  clampPlayerHealthToMax,
  collectAchievementReward,
  consumeAggroUnlockNotification,
  createPlayerProgression,
  gainPlayerXp,
  getPlayerLevel,
  getPlayerProgressionPayload,
  getPlayerRunStats,
  getXpRequiredForLevel,
  isPlayerDrafting,
  markAchievementsRead,
  maybeQueueLevelUpChoices,
  recordProgressionMetric,
  resetPlayerProgression,
};
