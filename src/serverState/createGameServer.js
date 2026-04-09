const { createInitialState } = require('./state/createInitialState');
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

  input.io.on('connection', (socket) => {
    restartGameLoop();
    registerSocketHandlers({ socket, io: input.io, state });
  });

  startGameLoop({ io: input.io, state });
}

module.exports = { createGameServer };
