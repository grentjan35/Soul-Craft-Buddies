const {
  PLAYER_MAX_HEALTH,
  ATTACK_DURATION,
  FIREBALL_POWER_MIN,
  FIREBALL_POWER_MAX,
  FIREBALL_MAX_DISTANCE,
  GRAVITY,
  SPECIAL_BEAM_RANGE,
} = require('../state/constants');
const { GroupManager } = require('../groups/groupManager');
const { HealingSystem } = require('../healing/healingSystem');
const { pickSpawnPoint } = require('./spawn/pickSpawnPoint');
const { dropSoulsForPlayerDeath, serializeSoulsForState } = require('../state/souls/soulSystem');
const { resolveCharacterSelection } = require('./characters/loadCharacters');
const { despawnEnemiesSpawnedForPlayer, resetEnemiesForState } = require('../enemies/runtime');
const {
  applyUpgradeSelection,
  clampPlayerHealthToMax,
  collectAchievementReward,
  createPlayerProgression,
  getPlayerRunStats,
  isPlayerDrafting,
  markAchievementsRead,
  recordProgressionMetric,
  resetPlayerProgression,
} = require('../state/progression/system');
const { emitProgressionNotification } = require('../state/progression/notifications');

function normalizeSpecialAttackName(name) {
  return String(name ?? '').trim().toLowerCase();
}

function canUnlockSpecialAttack({ name, character, requestedUnlock }) {
  if (!requestedUnlock) {
    return false;
  }

  const normalizedName = normalizeSpecialAttackName(name);
  const normalizedCharacter = String(character ?? '').trim().toLowerCase();
  return normalizedName === 'muhammad' || (normalizedName === 'pkducky' && normalizedCharacter === 'duck');
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

/**
 * Registers all Socket.IO event handlers for a connected client.
 * @param {{socket: import('socket.io').Socket, io: import('socket.io').Server, state: any}} input
 * @returns {void}
 */
function registerSocketHandlers(input) {
  const { socket, io, state } = input;
  const groupManager = new GroupManager(state);
  const healingSystem = new HealingSystem(state);

  function queueOrStartProjectileAttack(player, payload) {
    const runStats = getPlayerRunStats(player);
    const attackDuration = Math.max(0.18, Number(runStats.attackDuration) || ATTACK_DURATION);
    const queueWindow = Math.min(0.1, attackDuration * 0.35);
    const nowMs = Date.now();
    const now = nowMs / 1000;
    const requestedDx = Number(payload?.dx);
    const requestedDy = Number(payload?.dy);
    const requestedDistance = Number(payload?.distance);
    const maxRange = Math.max(96, Math.min(Number(runStats.fireballRange) || FIREBALL_MAX_DISTANCE, FIREBALL_MAX_DISTANCE));
    const targetDistance = Number.isFinite(requestedDistance)
      ? Math.max(48, Math.min(requestedDistance, maxRange))
      : maxRange;
    const fallbackAngle = typeof payload?.angle === 'number' ? payload.angle : 0;
    const targetDx = Number.isFinite(requestedDx) ? requestedDx : Math.cos(fallbackAngle) * targetDistance;
    const targetDy = Number.isFinite(requestedDy) ? requestedDy : Math.sin(fallbackAngle) * targetDistance;
    const angle = Math.atan2(targetDy, targetDx);
    const direction = targetDx >= 0 ? 'right' : 'left';
    const distanceRatio = Math.max(0, Math.min(1, targetDistance / FIREBALL_MAX_DISTANCE));
    const speedScale = Math.max(0.35, Number(runStats.fireballSpeedMultiplier) || 1);
    const referenceSpeed = (FIREBALL_POWER_MIN + (FIREBALL_POWER_MAX - FIREBALL_POWER_MIN) * distanceRatio) * speedScale;
    const effectiveSpeed = referenceSpeed * 2.35;
    const flightTime = Math.max(0.16, Math.min(targetDistance / Math.max(220, effectiveSpeed), 0.62));
    const gravityPerSecond = GRAVITY * 60 * Math.max(0.25, Number(runStats.fireballGravityScale) || 1);
    const vx = targetDx / flightTime;
    const vy = (targetDy - 0.5 * gravityPerSecond * flightTime * flightTime) / flightTime;

    if (player.is_attacking && now - (player.attack_start_time ?? 0) < attackDuration) {
      const elapsed = Math.max(0, now - (player.attack_start_time ?? 0));
      const remaining = Math.max(0, attackDuration - elapsed);
      if (remaining <= queueWindow) {
        player.queued_projectile_angle = angle;
        player.queued_projectile_vx = vx;
        player.queued_projectile_vy = vy;
        player.queued_projectile_direction = direction;
      }
      return;
    }

    player.is_attacking = true;
    player.attack_start_time = now;
    player.action = 'attack';
    player.direction = direction;
    player.pending_projectile_angle = angle;
    player.pending_projectile_vx = vx;
    player.pending_projectile_vy = vy;
  }

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
    if (isPlayerDrafting(player)) {
      player.inputs = { left: false, right: false, up: false };
      return;
    }
    const nextInputs = {
      left: Boolean(data?.left),
      right: Boolean(data?.right),
      up: Boolean(data?.up),
    };

    if (
      player.inputs.left === nextInputs.left &&
      player.inputs.right === nextInputs.right &&
      player.inputs.up === nextInputs.up
    ) {
      return;
    }

    player.inputs = nextInputs;
  });

  socket.on('jump', () => {
    const player = state.players.get(socket.id);
    if (!player || !player.is_ready) return;
    if (isPlayerDrafting(player)) return;
    const runStats = getPlayerRunStats(player);
    if (player.jumps_remaining > 0) {
      player.vy = Number.isFinite(runStats.jumpVelocity) ? runStats.jumpVelocity : -12 * 60;
      player.on_ground = false;
      player.jumps_remaining -= 1;
      const unlockedAchievements = recordProgressionMetric(player, 'jumps', 1);
      for (const achievement of unlockedAchievements) {
        emitProgressionNotification(io, socket.id, achievement);
      }
    }
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

    const chatChannel = data?.channel === 'group' ? 'group' : 'global';
    const payload = {
      sid: socket.id,
      name: String(player.name ?? `P${socket.id.slice(0, 4)}`),
      message,
      timestamp: Date.now(),
      channel: chatChannel,
    };

    if (chatChannel === 'group') {
      const groupInfo = groupManager.getGroupInfo(socket.id);
      if (!groupInfo) {
        socket.emit('group_error', { reason: 'You must be in a group to use group chat' });
        return;
      }

      for (const memberId of groupInfo.members) {
        io.to(memberId).emit('chat_message', payload);
      }
      return;
    }

    io.emit('chat_message', payload);
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
    if (isPlayerDrafting(player)) return;
    if (player.special_beam_requested || player.special_beam_active) return;
    queueOrStartProjectileAttack(player, data);
  });

  socket.on('special_attack_update', (data) => {
    const player = state.players.get(socket.id);
    if (!player || !player.is_ready) return;
    if (!player.special_attack_unlocked || isPlayerDrafting(player) || player.is_dying) {
      resetSpecialBeamState(player);
      return;
    }

    const wantsActive = Boolean(data?.active);
    if (!wantsActive) {
      resetSpecialBeamState(player);
      return;
    }

    const targetX = Number(data?.worldX);
    const targetY = Number(data?.worldY);
    if (!Number.isFinite(targetX) || !Number.isFinite(targetY)) {
      resetSpecialBeamState(player);
      return;
    }

    player.special_beam_requested = true;
    player.special_beam_target_x = Math.max(
      state.mapBounds.min_x - SPECIAL_BEAM_RANGE,
      Math.min(targetX, state.mapBounds.max_x + SPECIAL_BEAM_RANGE)
    );
    player.special_beam_target_y = Math.max(
      state.mapBounds.min_y - SPECIAL_BEAM_RANGE,
      Math.min(targetY, state.mapBounds.max_y + SPECIAL_BEAM_RANGE)
    );
    if (!player.special_beam_started_at) {
      player.special_beam_started_at = Date.now() / 1000;
    }

    player.is_attacking = false;
    player.attack_start_time = 0;
    player.pending_projectile_angle = null;
    player.pending_projectile_vx = 0;
    player.pending_projectile_vy = 0;
    player.queued_projectile_angle = null;
    player.queued_projectile_vx = 0;
    player.queued_projectile_vy = 0;
    player.queued_projectile_direction = null;
  });

  socket.on('select_upgrade', (data) => {
    const player = state.players.get(socket.id);
    if (!player || !player.is_ready) return;

    const cardId = String(data?.cardId ?? '').trim();
    if (!cardId) return;

    const result = applyUpgradeSelection(player, cardId);
    if (!result.ok) {
      socket.emit('upgrade_selection_error', { message: result.reason });
    }
  });

  socket.on('mark_achievements_seen', () => {
    const player = state.players.get(socket.id);
    if (!player) return;
    markAchievementsRead(player);
  });

  socket.on('collect_achievement_reward', (data) => {
    const player = state.players.get(socket.id);
    if (!player || !player.is_ready) return;

    const achievementId = String(data?.achievementId ?? '').trim();
    if (!achievementId) return;

    const result = collectAchievementReward(player, achievementId);
    if (!result.ok) {
      socket.emit('achievement_collect_error', { message: result.reason });
      return;
    }

    socket.emit('achievement_reward_collected', {
      achievementId,
      gainedXp: result.gainedXp,
      rewardXp: result.rewardXp,
      achievement: result.achievement,
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

  socket.on('group_create', (data) => {
    const requestedName = typeof data?.name === 'string' ? data.name : null;
    const result = groupManager.createGroupWithName(socket.id, requestedName);
    if (result.ok) {
      const groupInfo = groupManager.getGroupInfo(socket.id);
      socket.emit('group_created', groupInfo);
      io.emit('groups_updated', groupManager.serializeGroups());
    } else {
      socket.emit('group_error', { reason: result.reason });
    }
  });

  socket.on('group_request_join', (data) => {
    const groupId = String(data?.groupId ?? '').trim();
    if (!groupId) {
      socket.emit('group_error', { reason: 'Invalid group ID' });
      return;
    }

    const player = state.players.get(socket.id);
    if (!player) {
      socket.emit('group_error', { reason: 'Player not found' });
      return;
    }

    if (groupManager.findGroupByMember(socket.id)) {
      socket.emit('group_error', { reason: 'Player already in a group' });
      return;
    }

    const targetGroup = state.groups.get(groupId);
    if (!targetGroup) {
      socket.emit('group_error', { reason: 'Group not found' });
      return;
    }

    const leaderId = targetGroup.leaderId;
    const leader = state.players.get(leaderId);
    if (!leader) {
      socket.emit('group_error', { reason: 'Group leader is unavailable' });
      return;
    }

    const inviteId = `group_invite_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    state.pendingGroupInvites.set(inviteId, {
      id: inviteId,
      type: 'join_request',
      groupId,
      leaderId,
      requesterId: socket.id,
      targetId: socket.id,
      approverId: leaderId,
      createdAt: Date.now(),
    });

    io.to(leaderId).emit('group_invite_request', {
      inviteId,
      type: 'join_request',
      groupId,
      groupName: targetGroup.name || `${leader.name || 'Player'}'s Group`,
      requesterId: socket.id,
      requesterName: String(player.name ?? `P${socket.id.slice(0, 4)}`),
      leaderId,
      leaderName: String(leader.name ?? `P${leaderId.slice(0, 4)}`),
    });
    socket.emit('group_invite_pending', {
      inviteId,
      type: 'join_request',
      groupId,
      groupName: targetGroup.name || `${leader.name || 'Player'}'s Group`,
      message: `Join request sent to ${String(leader.name ?? 'the leader')}.`,
    });
  });

  socket.on('group_leave', () => {
    const result = groupManager.leaveGroup(socket.id);
    if (result.ok) {
      socket.emit('group_left');
      io.emit('groups_updated', groupManager.serializeGroups());
    } else {
      socket.emit('group_error', { reason: result.reason });
    }
  });

  socket.on('group_add_member', (data) => {
    let memberId = String(data?.memberId ?? '').trim();
    const memberName = String(data?.memberName ?? '').trim().toLowerCase();
    if (!memberId && memberName) {
      for (const [candidateId, player] of state.players.entries()) {
        const candidateName = String(player?.name ?? '').trim().toLowerCase();
        if (candidateName && candidateName === memberName) {
          memberId = candidateId;
          break;
        }
      }
    }
    if (!memberId) {
      socket.emit('group_error', { reason: 'Player not found' });
      return;
    }
    const leaderGroup = groupManager.findGroupByMember(socket.id);
    if (!leaderGroup) {
      socket.emit('group_error', { reason: 'Leader not in a group' });
      return;
    }
    if (leaderGroup.leaderId !== socket.id) {
      socket.emit('group_error', { reason: 'Only leader can add members' });
      return;
    }
    if (groupManager.findGroupByMember(memberId)) {
      socket.emit('group_error', { reason: 'Member already in a group' });
      return;
    }
    if (leaderGroup.members.includes(memberId)) {
      socket.emit('group_error', { reason: 'Member already in this group' });
      return;
    }

    const inviteId = `group_invite_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    state.pendingGroupInvites.set(inviteId, {
      id: inviteId,
      type: 'group_invite',
      groupId: leaderGroup.id,
      leaderId: socket.id,
      requesterId: socket.id,
      targetId: memberId,
      approverId: memberId,
      createdAt: Date.now(),
    });

    const leader = state.players.get(socket.id);
    io.to(memberId).emit('group_invite_request', {
      inviteId,
      type: 'group_invite',
      groupId: leaderGroup.id,
      groupName: leaderGroup.name || `${String(leader?.name || 'Player')}'s Group`,
      leaderId: socket.id,
      leaderName: String(leader?.name ?? `P${socket.id.slice(0, 4)}`),
      requesterId: socket.id,
      requesterName: String(leader?.name ?? `P${socket.id.slice(0, 4)}`),
    });
    socket.emit('group_invite_pending', {
      inviteId,
      type: 'group_invite',
      groupId: leaderGroup.id,
      groupName: leaderGroup.name || `${String(leader?.name || 'Player')}'s Group`,
      message: `Invite sent to ${String(state.players.get(memberId)?.name ?? data?.memberName ?? 'that player')}.`,
    });
  });

  socket.on('group_invite_respond', (data) => {
    const inviteId = String(data?.inviteId ?? '').trim();
    const accepted = Boolean(data?.accepted);
    if (!inviteId) {
      socket.emit('group_error', { reason: 'Invalid invite response' });
      return;
    }

    const invite = state.pendingGroupInvites.get(inviteId);
    if (!invite) {
      socket.emit('group_error', { reason: 'That group invite is no longer available' });
      return;
    }

    if (invite.approverId !== socket.id) {
      socket.emit('group_error', { reason: 'You cannot respond to that invite' });
      return;
    }

    state.pendingGroupInvites.delete(inviteId);

    const group = state.groups.get(invite.groupId);
    const leader = state.players.get(invite.leaderId);
    const joiningPlayer = state.players.get(invite.targetId);
    if (!accepted) {
      const denialMessage = invite.type === 'join_request'
        ? `${String(leader?.name ?? 'The leader')} declined your request to join ${group?.name || 'the group'}.`
        : `${String(joiningPlayer?.name ?? 'That player')} declined your invite to ${group?.name || 'the group'}.`;
      if (invite.type === 'join_request') {
        io.to(invite.requesterId).emit('group_invite_resolved', { inviteId, status: 'rejected', reason: denialMessage });
      } else {
        io.to(invite.leaderId).emit('group_invite_resolved', { inviteId, status: 'rejected', reason: denialMessage });
      }
      return;
    }

    if (!group) {
      socket.emit('group_error', { reason: 'Group not found' });
      return;
    }
    if (!leader || group.leaderId !== invite.leaderId) {
      socket.emit('group_error', { reason: 'That group invite is no longer valid' });
      return;
    }
    if (!joiningPlayer) {
      io.to(invite.leaderId).emit('group_invite_resolved', { inviteId, status: 'error', reason: 'Player not found' });
      return;
    }
    if (groupManager.findGroupByMember(invite.targetId)) {
      io.to(invite.leaderId).emit('group_invite_resolved', { inviteId, status: 'error', reason: 'Player already in a group' });
      if (invite.type === 'join_request') {
        io.to(invite.requesterId).emit('group_invite_resolved', { inviteId, status: 'error', reason: 'You are already in a group' });
      }
      return;
    }

    const joinResult = groupManager.joinGroup(invite.targetId, invite.groupId);
    if (!joinResult.ok) {
      io.to(invite.leaderId).emit('group_invite_resolved', { inviteId, status: 'error', reason: joinResult.reason });
      if (invite.type === 'join_request') {
        io.to(invite.requesterId).emit('group_invite_resolved', { inviteId, status: 'error', reason: joinResult.reason });
      }
      return;
    }

    const groupInfo = groupManager.getGroupInfo(invite.targetId);
    io.emit('groups_updated', groupManager.serializeGroups());
    io.to(invite.targetId).emit('group_joined', groupInfo);
    io.to(invite.leaderId).emit('group_info', groupManager.getGroupInfo(invite.leaderId));
    io.to(invite.leaderId).emit('group_member_added', { memberId: invite.targetId });
    io.to(invite.targetId).emit('group_invite_resolved', {
      inviteId,
      status: 'accepted',
      reason: `You joined ${groupInfo?.name || 'the group'}.`,
    });
    if (invite.type === 'join_request') {
      io.to(invite.requesterId).emit('group_invite_resolved', {
        inviteId,
        status: 'accepted',
        reason: `You joined ${groupInfo?.name || 'the group'}.`,
      });
    } else {
      io.to(invite.leaderId).emit('group_invite_resolved', {
        inviteId,
        status: 'accepted',
        reason: `${String(joiningPlayer.name ?? 'Player')} joined ${groupInfo?.name || 'the group'}.`,
      });
    }
  });

  socket.on('group_promote_leader', (data) => {
    const memberId = String(data?.memberId ?? '').trim();
    if (!memberId) {
      socket.emit('group_error', { reason: 'Invalid member ID' });
      return;
    }
    const result = groupManager.promoteLeader(socket.id, memberId);
    if (result.ok) {
      const promotedGroupInfo = groupManager.getGroupInfo(memberId);
      io.emit('groups_updated', groupManager.serializeGroups());
      socket.emit('group_info', groupManager.getGroupInfo(socket.id));
      io.to(memberId).emit('group_info', promotedGroupInfo);
      socket.emit('group_leader_promoted', { memberId });
      io.to(memberId).emit('group_leader_assigned', { leaderId: memberId });
    } else {
      socket.emit('group_error', { reason: result.reason });
    }
  });

  socket.on('group_kick_member', (data) => {
    const memberId = String(data?.memberId ?? '').trim();
    if (!memberId) {
      socket.emit('group_error', { reason: 'Invalid member ID' });
      return;
    }
    const result = groupManager.kickMember(socket.id, memberId);
    if (result.ok) {
      io.emit('groups_updated', groupManager.serializeGroups());
      io.to(memberId).emit('group_kicked');
      socket.emit('group_member_kicked', { memberId });
    } else {
      socket.emit('group_error', { reason: result.reason });
    }
  });

  socket.on('group_get_info', () => {
    const groupInfo = groupManager.getGroupInfo(socket.id);
    if (groupInfo) {
      socket.emit('group_info', groupInfo);
    } else {
      socket.emit('group_info', null);
    }
  });

  socket.on('healing_start', (data) => {
    const targetId = String(data?.targetId ?? '').trim();
    if (!targetId) {
      socket.emit('healing_error', { reason: 'Invalid target ID' });
      return;
    }
    const result = healingSystem.startHealing(socket.id, targetId);
    if (result.ok) {
      socket.emit('healing_started', { healingId: result.healingId, targetId });
      io.to(targetId).emit('healing_targeted', { healerId: socket.id });
    } else {
      socket.emit('healing_error', { reason: result.reason });
    }
  });

  socket.on('healing_stop', () => {
    const result = healingSystem.stopHealing(socket.id);
    if (result.ok) {
      socket.emit('healing_stopped');
    }
  });
}

/**
 * Handles connect initialization.
 * @param {{socket: import('socket.io').Socket, io: import('socket.io').Server, state: any}} input
 */
function handleConnect(input) {
  const nameQuery = input.socket.handshake?.query?.name;
  const characterQuery = input.socket.handshake?.query?.character;
  const specialUnlockQuery = input.socket.handshake?.query?.specialUnlock;
  const playerName = String(nameQuery ?? `Player_${input.socket.id.slice(0, 4)}`).slice(0, 15);

  const characterInfo = resolveCharacterSelection({
    state: input.state,
    requestedCharacter: characterQuery,
  });
  const character = characterInfo.character;
  const specialAttackUnlocked = canUnlockSpecialAttack({
    name: playerName,
    character,
    requestedUnlock: specialUnlockQuery === '1' || specialUnlockQuery === 'true',
  });

  const spawnPoint = pickSpawnPoint({ state: input.state });

  input.state.players.set(input.socket.id, {
    name: playerName,
    x: spawnPoint.x,
    y: spawnPoint.y,
    vx: 0,
    vy: 0,
    knockback_vx: 0,
    on_ground: false,
    inputs: { left: false, right: false, up: false },
    action: 'idle',
    direction: 'right',
    frame: 0,
    is_ready: false,
    jumps_remaining: 2,
    character,
    health: PLAYER_MAX_HEALTH,
    is_dying: false,
    death_time: 0,
    is_attacking: false,
    attack_start_time: 0,
    special_attack_unlocked: specialAttackUnlocked,
    special_beam_requested: false,
    special_beam_active: false,
    special_beam_target_x: 0,
    special_beam_target_y: 0,
    special_beam_from_x: 0,
    special_beam_from_y: 0,
    special_beam_to_x: 0,
    special_beam_to_y: 0,
    special_beam_started_at: 0,
    special_beam_damage_accumulator: 0,
    pending_projectile_angle: null,
    pending_projectile_vx: 0,
    pending_projectile_vy: 0,
    queued_projectile_angle: null,
    queued_projectile_vx: 0,
    queued_projectile_vy: 0,
    queued_projectile_direction: null,
    soul_count: 0,
    progression: createPlayerProgression(),
  });
  clampPlayerHealthToMax(input.state.players.get(input.socket.id));

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

  const activeSouls = serializeSoulsForState(input.state);
  if (Object.keys(activeSouls).length > 0) {
    input.socket.emit('initial_souls', activeSouls);
  }

  input.socket.emit('character_assigned', { character });
  input.socket.emit('groups_updated', new GroupManager(input.state).serializeGroups());
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

  dropSoulsForPlayerDeath(input.state, input.io, player);
  despawnEnemiesSpawnedForPlayer(input.state, input.socket.id);
  input.state.deadBodies.set(input.socket.id, deathData);
  input.io.emit('player_dying', deathData);
  
  // Clean up healing sessions
  input.state.activeHealings.delete(input.socket.id);
  
  // Remove player from group if in one
  if (player.groupId) {
    const groupManager = new GroupManager(input.state);
    groupManager.leaveGroup(input.socket.id);
    input.io.emit('groups_updated', groupManager.serializeGroups());
  }

  for (const [inviteId, invite] of input.state.pendingGroupInvites.entries()) {
    if (
      invite.leaderId === input.socket.id ||
      invite.requesterId === input.socket.id ||
      invite.targetId === input.socket.id ||
      invite.approverId === input.socket.id
    ) {
      input.state.pendingGroupInvites.delete(inviteId);
    }
  }
  
  input.state.players.delete(input.socket.id);
}

/**
 * Respawns a player onto a random valid platform with reset health.
 * @param {{socketId: string, state: any}} input
 */
function respawnPlayer(input) {
  const player = input.state.players.get(input.socketId);
  if (!player) return;

  const spawn = pickSpawnPoint({ state: input.state });

  player.x = spawn.x;
  player.y = spawn.y;
  player.vx = 0;
  player.vy = 0;
  player.knockback_vx = 0;
  player.on_ground = false;
  player.jumps_remaining = 2;
  resetPlayerProgression(player);
  player.health = Math.max(1, Math.round(getPlayerRunStats(player).maxHealth || PLAYER_MAX_HEALTH));
  player.is_dying = false;
  player.death_time = 0;
  player.is_attacking = false;
  player.attack_start_time = 0;
  resetSpecialBeamState(player);
  player.pending_projectile_angle = null;
  player.pending_projectile_vx = 0;
  player.pending_projectile_vy = 0;
  player.queued_projectile_angle = null;
  player.queued_projectile_vx = 0;
  player.queued_projectile_vy = 0;
  player.queued_projectile_direction = null;
  player.soul_count = 0;
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
  const { buildPlatformNavigation } = require('../state/platformNavigation/buildPlatformNavigation');
  const { buildPlatformsFromMap } = require('../state/platforms/buildPlatformsFromMap');
  const { initializeFairies } = require('../state/fairies/fairySystem');
  const { loadEnemyCatalog } = require('../../enemies/catalog');

  const mapName = String(input.data?.name ?? 'default');
  const isSameMap = input.state.currentMapName === mapName;
  const mapPath = path.join(input.state.dataDir, `${mapName}.json`);
  if (!fs.existsSync(mapPath)) {
    return;
  }

  const mapData = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

  const tiles = mapData.tiles;
  const mapWidth = mapData.width;
  const mapHeight = mapData.height;
  const platforms = buildPlatformsFromMap(mapData);

  input.state.platforms = platforms;
  input.state.platformGrid = buildPlatformGrid({ platforms });
  input.state.platformNavigation = buildPlatformNavigation({ platforms });
  input.state.fairies = initializeFairies({ platforms });
  input.state.currentMapName = mapName;
  input.state.mapBounds = {
    min_x: 0,
    max_x: mapWidth * TILE_SIZE,
    min_y: 0,
    max_y: mapHeight * TILE_SIZE,
  };

  input.state.spawnPoints = Array.isArray(mapData.spawnPoints)
    ? mapData.spawnPoints
    : [{ x: 100, y: 500, id: 0 }];
  input.state.enemyDefinitions = loadEnemyCatalog({ staticDir: input.state.config.staticDir });
  input.state.enemySpawns = [];
  resetEnemiesForState({ state: input.state });

  const player = input.state.players.get(input.socket.id);
  if (player) {
    const spawn = pickSpawnPoint({ state: input.state });
    player.x = spawn.x;
    player.y = spawn.y;
    player.vx = 0;
    player.vy = 0;
    player.knockback_vx = 0;
    player.on_ground = false;
  }

  const payload = {
    name: mapName,
    width: mapWidth,
    height: mapHeight,
    tiles,
    spawnPoints: input.state.spawnPoints,
    backgrounds: Array.isArray(mapData.backgrounds) ? mapData.backgrounds : [],
    enemies: input.state.enemySpawns,
    decor: Array.isArray(mapData.decor) ? mapData.decor : [],
  };

  if (isSameMap) {
    input.socket.emit('map_loaded', payload);
    return;
  }

  input.io.emit('map_loaded', payload);
}

module.exports = { registerSocketHandlers };
