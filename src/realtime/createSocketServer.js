const { Server } = require('socket.io');

const { createGameServer } = require('../serverState/createGameServer');

/**
 * Creates Socket.IO server and wires handlers.
 * @param {{httpServer: import('http').Server, config: any}} input
 * @returns {import('socket.io').Server}
 */
function createSocketServer(input) {
  const io = new Server(input.httpServer, {
    path: '/socket.io/',
    cors: { origin: '*' },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  createGameServer({ io, config: input.config });
  return io;
}

module.exports = { createSocketServer };
