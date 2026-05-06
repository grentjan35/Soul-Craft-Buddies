const { createInitialState, hydrateState, dehydrateState } = require('./state/createInitialState');
const { registerSocketHandlers } = require('./sockets/registerSocketHandlers');
const { startGameLoop, restartGameLoop } = require('./tick/startGameLoop');

/**
 * Runs garbage collection if enabled.
 * Why: Node/V8 may keep RSS high after gameplay; idle-only GC helps reclaim memory.
 * @param {{state: any}} input
 * @returns {void}
 */
function runIdleGarbageCollection(input) {
  const gcFn = /** @type {undefined | (() => void)} */ (global.gc);
  if (typeof gcFn !== 'function') {
    return;
  }

  if (!input.state || input.state.players?.size > 0) {
    return;
  }

  try {
    gcFn();
    setTimeout(() => {
      if (!input.state || input.state.players?.size > 0) {
        return;
      }
      gcFn();
    }, 50);
  } catch {
    // Ignore GC errors (best-effort only).
  }
}

/**
 * Creates the game state and registers realtime handlers + loop.
 * Why: Keep all mutable state scoped, not global.
 * @param {{io: import('socket.io').Server, config: any}} input
 * @returns {void}
 */
function createGameServer(input) {
  const state = createInitialState({ config: input.config });

  /** @type {NodeJS.Timeout | null} */
  let dehydrateTimer = null;
  const dehydrateDelayMs = 60_000;

  input.io.on('connection', (socket) => {
    if (dehydrateTimer) {
      clearTimeout(dehydrateTimer);
      dehydrateTimer = null;
    }

    hydrateState(state);
    restartGameLoop();
    registerSocketHandlers({ socket, io: input.io, state });

    socket.on('disconnect', () => {
      setTimeout(() => {
        if (state.players.size > 0) {
          return;
        }

        if (dehydrateTimer) {
          clearTimeout(dehydrateTimer);
        }

        dehydrateTimer = setTimeout(() => {
          if (state.players.size > 0) {
            return;
          }
          dehydrateState(state);
          runIdleGarbageCollection({ state });
        }, dehydrateDelayMs);
      }, 0);
    });
  });

  startGameLoop({ io: input.io, state });
}

module.exports = { createGameServer };
