const http = require('http');
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
    httpCompression: true,
    perMessageDeflate: true,
    pingTimeout: 120000,
    pingInterval: 10000,
  });

  createGameServer({ io, config: input.config });

  // Keep-alive mechanism: request tiny image every 14 minutes if there are active connections
  // This prevents Render.com from spinning down during active WebSocket gameplay
  const KEEP_ALIVE_INTERVAL_MS = 14 * 60 * 1000; // 14 minutes
  let keepAliveTimer = null;

  const startKeepAlive = () => {
    if (keepAliveTimer) return;

    keepAliveTimer = setInterval(() => {
      const activeConnections = io.sockets.sockets.size;
      if (activeConnections > 0) {
        // Make minimal HTTP request to keep-alive endpoint (serves local asset, no CDN)
        const port = input.httpServer.address().port;
        const options = {
          hostname: 'localhost',
          port: port,
          path: '/keep-alive',
          method: 'GET',
        };

        const req = http.request(options, (res) => {
          // Consume response to avoid memory leak
          res.resume();
        });

        req.on('error', (err) => {
          // Silently ignore errors - keep-alive is best-effort
        });

        req.end();
      }
    }, KEEP_ALIVE_INTERVAL_MS);
  };

  const stopKeepAlive = () => {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }
  };

  // Start keep-alive when first client connects, stop when last disconnects
  io.on('connection', (socket) => {
    if (io.sockets.sockets.size === 1) {
      startKeepAlive();
    }

    socket.on('disconnect', () => {
      if (io.sockets.sockets.size === 0) {
        stopKeepAlive();
      }
    });
  });

  return io;
}

module.exports = { createSocketServer };
