const http = require('http');

const { createApp } = require('./src/app');
const { getConfig } = require('./src/config/getConfig');
const { createSocketServer } = require('./src/realtime/createSocketServer');

/**
 * Starts keep-alive pings to prevent Render.com spin-down.
 * Why: Render only monitors HTTP traffic for activity, not WebSocket.
 * @param {number} port - Server port
 * @param {number} intervalMs - Ping interval in milliseconds
 * @returns {NodeJS.Timeout}
 */
function startKeepAlive(port, intervalMs = 10 * 60 * 1000) {
  const pingUrl = `http://localhost:${port}/health`;

  const ping = () => {
    http.get(pingUrl, (res) => {
      console.log(`Keep-alive ping: ${res.statusCode} - ${new Date().toISOString()}`);
    }).on('error', (err) => {
      console.error('Keep-alive ping failed:', err.message);
    });
  };

  // Initial ping after 30 seconds
  setTimeout(ping, 30000);

  // Periodic pings
  return setInterval(ping, intervalMs);
}

/**
 * Bootstraps the HTTP + Socket.IO server.
 * @returns {Promise<void>}
 */
async function main() {
  const config = getConfig();
  const app = await createApp(config);

  const httpServer = http.createServer(app);
  createSocketServer({ httpServer, config });

  httpServer.listen(config.port, config.bindHost, () => {
    console.log('='.repeat(60));
    console.log('Platformer Buddies Node Server Started!');
    console.log(`Main Game: http://localhost:${config.port}/`);
    console.log(`Editor:   http://localhost:${config.port}/editor`);
    console.log(`Enhancer: http://localhost:${config.port}/enhancer`);
    console.log('='.repeat(60));

    // Start keep-alive pings for Render.com
    if (process.env.RENDER || process.env.RENDER_SERVICE_NAME) {
      startKeepAlive(config.port);
      console.log('Keep-alive pings enabled for Render.com');
    }
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exitCode = 1;
});
