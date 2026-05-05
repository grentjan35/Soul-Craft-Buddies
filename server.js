const http = require('http');

const { createApp } = require('./src/app');
const { getConfig } = require('./src/config/getConfig');
const { createSocketServer } = require('./src/realtime/createSocketServer');
const { getTotalResponseStats } = require('./src/http/middleware/createResponseSizeMiddleware');

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
    console.log(`Main Game:    http://localhost:${config.port}/`);
    console.log(`Editor:       http://localhost:${config.port}/editor`);
    console.log(`Enhancer:     http://localhost:${config.port}/enhancer`);
    console.log(`WebSocket Monitor: http://localhost:${config.port}/websocket-monitor`);
    console.log('='.repeat(60));

  });

  setInterval(() => {
    const stats = getTotalResponseStats();
    if (stats.responseCount > 0) {
      console.log('='.repeat(60));
      console.log(`Total HTTP Responses: ${stats.responseCount}`);
      console.log(`Total Data Sent: ${stats.formattedTotal} total`);
      console.log('='.repeat(60));
    }
  }, 60000);
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exitCode = 1;
});
