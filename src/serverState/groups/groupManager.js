/**
 * GroupManager - Manages group relationships for multiplayer collaboration.
 * Handles group creation, membership, and leader-based operations.
 */

class GroupManager {
  /**
   * Creates a new GroupManager instance.
   * @param {{ groups: Map<string, any> }} state - The game state containing groups map
   */
  constructor(state) {
    this.state = state;
  }

  /**
   * Creates a new group with the player as leader.
   * @param {string} playerId - The socket ID of the player creating the group
   * @returns {{ok: boolean, groupId?: string, reason?: string}}
   */
  createGroup(playerId) {
    return this.createGroupWithName(playerId, null);
  }

  /**
   * Creates a new group with a specific display name.
   * @param {string} playerId
   * @param {string | null | undefined} requestedName
   * @returns {{ok: boolean, groupId?: string, reason?: string}}
   */
  createGroupWithName(playerId, requestedName) {
    const player = this.state.players.get(playerId);
    if (!player) {
      return { ok: false, reason: 'Player not found' };
    }

    // Check if player is already in a group
    const existingGroup = this.findGroupByMember(playerId);
    if (existingGroup) {
      return { ok: false, reason: 'Player already in a group' };
    }

    const groupId = `group_${Date.now()}_${playerId.slice(0, 4)}`;
    const defaultGroupName = `${String(player.name || `P${playerId.slice(0, 4)}`).trim() || 'Player'}'s Group`;
    const normalizedRequestedName = typeof requestedName === 'string' ? requestedName.trim() : '';
    const groupName = normalizedRequestedName || defaultGroupName;
    const group = {
      id: groupId,
      name: groupName.slice(0, 40),
      leaderId: playerId,
      members: [playerId],
      createdAt: Date.now(),
    };

    this.state.groups.set(groupId, group);
    player.groupId = groupId;
    player.isGroupLeader = true;

    console.log(`Group Created: ${groupId} by leader ${playerId}`);
    return { ok: true, groupId };
  }

  /**
   * Removes a player from their group (the "Betray" logic).
   * @param {string} playerId - The socket ID of the player leaving
   * @returns {{ok: boolean, reason?: string}}
   */
  leaveGroup(playerId) {
    const player = this.state.players.get(playerId);
    if (!player) {
      return { ok: false, reason: 'Player not found' };
    }

    const group = this.findGroupByMember(playerId);
    if (!group) {
      return { ok: false, reason: 'Player not in a group' };
    }

    // Remove player from group
    group.members = group.members.filter(id => id !== playerId);
    player.groupId = null;
    player.isGroupLeader = false;

    // If leader left, assign new leader or disband group
    if (group.leaderId === playerId) {
      if (group.members.length > 0) {
        group.leaderId = group.members[0];
        const newLeader = this.state.players.get(group.leaderId);
        if (newLeader) {
          newLeader.isGroupLeader = true;
        }
      } else {
        this.state.groups.delete(group.id);
        console.log(`Group disbanded: ${group.id}`);
        return { ok: true };
      }
    }

    console.log(`Player ${playerId} left group ${group.id}`);
    return { ok: true };
  }

  /**
   * Adds a member to an existing group.
   * Only the leader can add members.
   * @param {string} leaderId - The socket ID of the group leader
   * @param {string} memberId - The socket ID of the player to add
   * @returns {{ok: boolean, reason?: string}}
   */
  addMember(leaderId, memberId) {
    const leader = this.state.players.get(leaderId);
    if (!leader) {
      return { ok: false, reason: 'Leader not found' };
    }

    const member = this.state.players.get(memberId);
    if (!member) {
      return { ok: false, reason: 'Member not found' };
    }

    const group = this.findGroupByMember(leaderId);
    if (!group) {
      return { ok: false, reason: 'Leader not in a group' };
    }

    if (group.leaderId !== leaderId) {
      return { ok: false, reason: 'Only leader can add members' };
    }

    // Check if member is already in a group
    const memberExistingGroup = this.findGroupByMember(memberId);
    if (memberExistingGroup) {
      return { ok: false, reason: 'Member already in a group' };
    }

    // Check if member is already in this group
    if (group.members.includes(memberId)) {
      return { ok: false, reason: 'Member already in this group' };
    }

    group.members.push(memberId);
    member.groupId = group.id;
    member.isGroupLeader = false;

    console.log(`Member ${memberId} added to group ${group.id}`);
    return { ok: true };
  }

  /**
   * Promotes a member to become the new leader of the group.
   * @param {string} leaderId
   * @param {string} memberId
   * @returns {{ok: boolean, reason?: string}}
   */
  promoteLeader(leaderId, memberId) {
    const leader = this.state.players.get(leaderId);
    if (!leader) {
      return { ok: false, reason: 'Leader not found' };
    }

    const member = this.state.players.get(memberId);
    if (!member) {
      return { ok: false, reason: 'Member not found' };
    }

    const group = this.findGroupByMember(leaderId);
    if (!group) {
      return { ok: false, reason: 'Leader not in a group' };
    }

    if (group.leaderId !== leaderId) {
      return { ok: false, reason: 'Only leader can promote members' };
    }

    if (!group.members.includes(memberId)) {
      return { ok: false, reason: 'Member not in this group' };
    }

    if (memberId === leaderId) {
      return { ok: false, reason: 'That player is already the leader' };
    }

    group.leaderId = memberId;
    leader.isGroupLeader = false;
    member.isGroupLeader = true;
    console.log(`Leader changed: ${leaderId} -> ${memberId} in group ${group.id}`);
    return { ok: true };
  }

  /**
   * Kicks a member from the group.
   * Only the leader can kick members.
   * @param {string} leaderId - The socket ID of the group leader
   * @param {string} memberId - The socket ID of the player to kick
   * @returns {{ok: boolean, reason?: string}}
   */
  kickMember(leaderId, memberId) {
    const leader = this.state.players.get(leaderId);
    if (!leader) {
      return { ok: false, reason: 'Leader not found' };
    }

    const member = this.state.players.get(memberId);
    if (!member) {
      return { ok: false, reason: 'Member not found' };
    }

    const group = this.findGroupByMember(leaderId);
    if (!group) {
      return { ok: false, reason: 'Leader not in a group' };
    }

    if (group.leaderId !== leaderId) {
      return { ok: false, reason: 'Only leader can kick members' };
    }

    if (group.leaderId === memberId) {
      return { ok: false, reason: 'Cannot kick the leader' };
    }

    if (!group.members.includes(memberId)) {
      return { ok: false, reason: 'Member not in this group' };
    }

    group.members = group.members.filter(id => id !== memberId);
    member.groupId = null;
    member.isGroupLeader = false;

    console.log(`Member ${memberId} kicked from group ${group.id}`);
    return { ok: true };
  }

  /**
   * Joins an existing group.
   * @param {string} playerId
   * @param {string} groupId
   * @returns {{ok: boolean, reason?: string}}
   */
  joinGroup(playerId, groupId) {
    const player = this.state.players.get(playerId);
    if (!player) {
      return { ok: false, reason: 'Player not found' };
    }

    if (this.findGroupByMember(playerId)) {
      return { ok: false, reason: 'Player already in a group' };
    }

    const group = this.state.groups.get(groupId);
    if (!group) {
      return { ok: false, reason: 'Group not found' };
    }

    if (group.members.includes(playerId)) {
      return { ok: false, reason: 'Player already in this group' };
    }

    group.members.push(playerId);
    player.groupId = group.id;
    player.isGroupLeader = false;
    console.log(`Player ${playerId} joined group ${group.id}`);
    return { ok: true };
  }

  /**
   * Finds the group a player belongs to.
   * @param {string} playerId - The socket ID of the player
   * @returns {any | null}
   */
  findGroupByMember(playerId) {
    for (const group of this.state.groups.values()) {
      if (group.members.includes(playerId)) {
        return group;
      }
    }
    return null;
  }

  /**
   * Gets group information for a player.
   * @param {string} playerId - The socket ID of the player
   * @returns {{id: string, leaderId: string, members: string[], memberNames: string[]} | null}
   */
  getGroupInfo(playerId) {
    const group = this.findGroupByMember(playerId);
    if (!group) {
      return null;
    }

    const memberNames = group.members.map(id => {
      const player = this.state.players.get(id);
      return player ? (player.name || `P${id.slice(0, 4)}`) : `Unknown`;
    });

    return {
      id: group.id,
      name: group.name || 'Group',
      leaderId: group.leaderId,
      members: group.members,
      memberNames,
    };
  }

  /**
   * Serializes all groups for client transmission.
   * @returns {Record<string, any>}
   */
  serializeGroups() {
    const serialized = {};
    for (const [groupId, group] of this.state.groups.entries()) {
      const leader = this.state.players.get(group.leaderId);
      serialized[groupId] = {
        id: group.id,
        name: group.name || 'Group',
        leaderId: group.leaderId,
        members: group.members,
        memberCount: group.members.length,
        leaderName: leader ? (leader.name || `P${group.leaderId.slice(0, 4)}`) : `P${group.leaderId.slice(0, 4)}`,
      };
    }
    return serialized;
  }
}

module.exports = { GroupManager };
