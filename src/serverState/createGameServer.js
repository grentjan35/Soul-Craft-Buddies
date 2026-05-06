const { createInitialState, hydrateState, dehydrateState } = require('./state/createInitialState');
const { registerSocketHandlers } = require('./sockets/registerSocketHandlers');
const { startGameLoop, restartGameLoop } = require('./tick/startGameLoop');

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
        }, dehydrateDelayMs);
      }, 0);
    });
  });

  startGameLoop({ io: input.io, state });
}

module.exports = { createGameServer };
