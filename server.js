const http = require('http');

const { createApp } = require('./src/app');
const { getConfig } = require('./src/config/getConfig');
const { createSocketServer } = require('./src/realtime/createSocketServer');

/**
 * Bootstraps the HTTP + Socket.IO server.
 * @returns {Promise<void>}
 */
async function main() {
  console.log('Starting server configuration...');
  const config = getConfig();
  console.log(`Configuration loaded - Port: ${config.port}, Host: ${config.bindHost}`);

  console.log('Creating Express app...');
  const app = await createApp(config);

  console.log('Creating HTTP server...');
  const httpServer = http.createServer(app);

  httpServer.on('error', (err) => {
    console.error('HTTP server error:', err);
    process.exit(1);
  });

  console.log('Creating Socket.IO server...');
  createSocketServer({ httpServer, config });

  console.log(`Starting server on ${config.bindHost}:${config.port}...`);
  httpServer.listen(config.port, config.bindHost, () => {
    console.log('='.repeat(60));
    console.log('Platformer Buddies Node Server Started!');
    console.log(`Port: ${config.port}`);
    console.log(`Host: ${config.bindHost}`);
    console.log(`Main Game: http://localhost:${config.port}/`);
    console.log(`Editor:   http://localhost:${config.port}/editor`);
    console.log(`Enhancer: http://localhost:${config.port}/enhancer`);
    console.log('='.repeat(60));
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  console.error('Error stack:', err.stack);
  process.exitCode = 1;
});
