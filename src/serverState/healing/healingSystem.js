/**
 * HealingSystem - Manages proximity-based collaborative healing mechanic.
 * Players in the same group can heal each other by holding a key near each other.
 */

const HEAL_DISTANCE = 100;
const HEAL_RATE = 10;
const HEAL_TICK_RATE = 0.1;

class HealingSystem {
  /**
   * Creates a new HealingSystem instance.
   * @param {{ players: Map<string, any>, groups: Map<string, any>, activeHealings: Map<string, any> }} state
   */
  constructor(state) {
    this.state = state;
  }

  /**
   * Starts healing between two players.
   * @param {string} healerId - The socket ID of the player initiating healing
   * @param {string} targetId - The socket ID of the target player
   * @returns {{ok: boolean, reason?: string}}
   */
  startHealing(healerId, targetId) {
    const healer = this.state.players.get(healerId);
    const target = this.state.players.get(targetId);

    if (!healer || !target) {
      return { ok: false, reason: 'Player not found' };
    }

    if (healerId === targetId) {
      return { ok: false, reason: 'Cannot heal yourself' };
    }

    // Check if players are in the same group
    const healerGroup = this.findGroupByMember(healerId);
    const targetGroup = this.findGroupByMember(targetId);

    if (!healerGroup || !targetGroup || healerGroup.id !== targetGroup.id) {
      return { ok: false, reason: 'Players must be in the same group' };
    }

    // Check distance
    const distance = this.getDistance(healer, target);
    if (distance > HEAL_DISTANCE) {
      return { ok: false, reason: 'Target too far away' };
    }

    // Check if either player is already healing
    const existingHealing = this.state.activeHealings.get(healerId);
    if (existingHealing) {
      return { ok: false, reason: 'Already healing' };
    }

    // Create healing session
    const healingId = `heal_${healerId}_${targetId}_${Date.now()}`;
    this.state.activeHealings.set(healerId, {
      id: healingId,
      healerId,
      targetId,
      startTime: Date.now(),
      lastHealTime: Date.now(),
    });

    console.log(`Healing started: ${healerId} -> ${targetId}`);
    return { ok: true, healingId };
  }

  /**
   * Stops an active healing session.
   * @param {string} healerId - The socket ID of the healer
   * @returns {{ok: boolean}}
   */
  stopHealing(healerId) {
    const healing = this.state.activeHealings.get(healerId);
    if (!healing) {
      return { ok: false };
    }

    this.state.activeHealings.delete(healerId);
    console.log(`Healing stopped: ${healerId}`);
    return { ok: true };
  }

  /**
   * Updates all active healing sessions.
   * Called each game tick to apply healing and validate conditions.
   * @param {number} dt - Delta time in seconds
   * @returns {Array<{healerId: string, targetId: string, amount: number}>}
   */
  update(dt) {
    const healEvents = [];
    const now = Date.now();

    for (const [healerId, healing] of this.state.activeHealings.entries()) {
      const healer = this.state.players.get(healerId);
      const target = this.state.players.get(healing.targetId);

      // Stop if either player disconnected
      if (!healer || !target) {
        this.state.activeHealings.delete(healerId);
        continue;
      }

      // Check if players are still in the same group
      const healerGroup = this.findGroupByMember(healerId);
      const targetGroup = this.findGroupByMember(healing.targetId);

      if (!healerGroup || !targetGroup || healerGroup.id !== targetGroup.id) {
        this.state.activeHealings.delete(healerId);
        continue;
      }

      // Check distance
      const distance = this.getDistance(healer, target);
      if (distance > HEAL_DISTANCE) {
        this.state.activeHealings.delete(healerId);
        continue;
      }

      // Apply healing at tick rate
      if (now - healing.lastHealTime >= HEAL_TICK_RATE * 1000) {
        const healAmount = HEAL_RATE * HEAL_TICK_RATE;

        // Heal both players
        healer.health = Math.min(healer.health + healAmount, this.state.maxHealth);
        target.health = Math.min(target.health + healAmount, this.state.maxHealth);

        healing.lastHealTime = now;
        healEvents.push({
          healerId,
          targetId: healing.targetId,
          amount: healAmount,
        });
      }
    }

    return healEvents;
  }

  /**
   * Calculates Euclidean distance between two players.
   * @param {{x: number, y: number}} player1
   * @param {{x: number, y: number}} player2
   * @returns {number}
   */
  getDistance(player1, player2) {
    const dx = player1.x - player2.x;
    const dy = player1.y - player2.y;
    return Math.sqrt(dx * dx + dy * dy);
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
   * Serializes active healings for client transmission.
   * @returns {Record<string, any>}
   */
  serializeActiveHealings() {
    const serialized = {};
    for (const [healerId, healing] of this.state.activeHealings.entries()) {
      const healer = this.state.players.get(healerId);
      const target = this.state.players.get(healing.targetId);

      if (healer && target) {
        serialized[healing.id] = {
          id: healing.id,
          healerId,
          targetId: healing.targetId,
          healerX: healer.x,
          healerY: healer.y,
          targetX: target.x,
          targetY: target.y,
        };
      }
    }
    return serialized;
  }
}

module.exports = { HealingSystem, HEAL_DISTANCE, HEAL_RATE };
