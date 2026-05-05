const http = require('http');
const { Server } = require('socket.io');

const { createGameServer } = require('../serverState/createGameServer');

// WebSocket monitoring stats
const monitorStats = {
  totalMessages: 0,
  totalBytesCompressed: 0,
  totalBytesUncompressed: 0,
  messagesPerSecond: 0,
  activeConnections: 0,
  messageHistory: [],
  lastSecondMessages: 0,
  lastSecondTime: Date.now()
};

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
    transports: ['websocket'],
    httpCompression: true,
    perMessageDeflate: {
      threshold: 1024,
      zlibDeflateOptions: {
        level: 3,
      },
      zlibInflateOptions: {
        chunkSize: 10 * 1024,
      },
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      serverMaxWindowBits: 10,
    },
    pingTimeout: 120000,
    pingInterval: 10000,
  });

  const monitoringEnabled = String(process.env.SOCKET_MONITORING || '').toLowerCase() === '1';
  /** @type {Set<string>} */
  const monitorSocketIds = new Set();
  /** @type {NodeJS.Timeout | null} */
  let monitorInterval = null;

  createGameServer({ io, config: input.config });

  // Monitoring middleware to track message sizes
  io.use((socket, next) => {
    if (!monitoringEnabled) {
      next();
      return;
    }
    // Track connection count
    monitorStats.activeConnections = io.sockets.sockets.size;
    
    // Override emit to track outgoing messages
    const originalEmit = socket.emit.bind(socket);
    socket.emit = (eventName, ...args) => {
      trackMessage(eventName, args, 'emit');
      return originalEmit(eventName, ...args);
    };
    
    // Override on to track incoming messages
    const originalOn = socket.on.bind(socket);
    socket.on = (eventName, listener) => {
      return originalOn(eventName, (...args) => {
        trackMessage(eventName, args, 'receive');
        listener(...args);
      });
    };
    
    next();
  });

  // Handle monitor-specific events
  io.on('connection', (socket) => {
    monitorStats.activeConnections = io.sockets.sockets.size;
    
    socket.on('start-monitor', () => {
      if (!monitoringEnabled) {
        return;
      }

      monitorSocketIds.add(socket.id);

      if (!monitorInterval) {
        monitorStats.lastSecondMessages = 0;
        monitorStats.lastSecondTime = Date.now();
        monitorInterval = setInterval(() => {
          const now = Date.now();
          const diff = now - monitorStats.lastSecondTime;

          if (diff >= 1000) {
            monitorStats.messagesPerSecond = monitorStats.lastSecondMessages;
            monitorStats.lastSecondMessages = 0;
            monitorStats.lastSecondTime = now;

            if (monitorSocketIds.size > 0) {
              io.emit('monitor-stats', {
                activeConnections: monitorStats.activeConnections,
                totalMessages: monitorStats.totalMessages,
                totalBytesCompressed: monitorStats.totalBytesCompressed,
                totalBytesUncompressed: monitorStats.totalBytesUncompressed,
                messagesPerSecond: monitorStats.messagesPerSecond
              });
            }
          }
        }, 1000);
      }

      // Send current stats to monitor
      socket.emit('monitor-stats', {
        activeConnections: monitorStats.activeConnections,
        totalMessages: monitorStats.totalMessages,
        totalBytesCompressed: monitorStats.totalBytesCompressed,
        totalBytesUncompressed: monitorStats.totalBytesUncompressed,
        messagesPerSecond: monitorStats.messagesPerSecond
      });
    });
    
    socket.on('disconnect', () => {
      monitorStats.activeConnections = io.sockets.sockets.size;

      if (monitoringEnabled) {
        monitorSocketIds.delete(socket.id);
        if (monitorSocketIds.size === 0 && monitorInterval) {
          clearInterval(monitorInterval);
          monitorInterval = null;
        }
      }
    });
  });

  function trackMessage(eventName, args, direction) {
    if (!monitoringEnabled || monitorSocketIds.size === 0) {
      return;
    }
    const jsonString = JSON.stringify(args);
    const uncompressedSize = Buffer.byteLength(jsonString, 'utf8');
    
    // Simulate compression based on current settings
    // In reality, perMessageDeflate handles this, but we estimate for monitoring
    const compressionRatio = uncompressedSize > 1024 ? 0.6 : 1.0; // 60% compression for messages > 1KB
    const compressedSize = Math.floor(uncompressedSize * compressionRatio);
    
    monitorStats.totalMessages++;
    monitorStats.totalBytesCompressed += compressedSize;
    monitorStats.totalBytesUncompressed += uncompressedSize;
    monitorStats.lastSecondMessages++;
    
    // Keep message history for detailed tracking
    monitorStats.messageHistory.unshift({
      timestamp: new Date(),
      eventName,
      direction,
      uncompressedSize,
      compressedSize,
      compressionRatio: Math.round((1 - compressionRatio) * 100)
    });
    
    // Limit history to last 100 messages
    if (monitorStats.messageHistory.length > 20) {
      monitorStats.messageHistory.pop();
    }
  }

  // Keep-alive mechanism: request tiny image every 14 minutes if there are active connections
  // This prevents Render.com from spinning down during active WebSocket gameplay
  const keepAliveEnabled = String(process.env.SOCKET_KEEP_ALIVE || '').toLowerCase() === '1';
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
  if (keepAliveEnabled) {
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
  }

  return io;
}

module.exports = { createSocketServer };
