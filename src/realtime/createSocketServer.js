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
    serveClient: true,
    transports: ['websocket', 'polling'],
    httpCompression: false,
    perMessageDeflate: false,
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // Simple WebSocket Response Logging (disabled)
  // const originalEmit = io.emit;
  // io.emit = function(event, data) {
  //   const dataSize = Buffer.byteLength(JSON.stringify({ event, data }));
  //   console.log(`[WebSocket Response] Event: ${event} - Size: ${dataSize} bytes`, data);
  //   return originalEmit.call(this, event, data);
  // };

  createGameServer({ io, config: input.config });
  return io;
}

module.exports = { createSocketServer };
