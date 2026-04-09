const express = require('express');
const cors = require('cors');

const { createCompressionMiddleware } = require('./http/middleware/createCompressionMiddleware');
const { createPagesRouter } = require('./http/pages/createPagesRouter');
const { createHealthRouter } = require('./http/health/createHealthRouter');
const { createMapsRouter } = require('./http/maps/createMapsRouter');
const { createAssetsRouter } = require('./http/assets/createAssetsRouter');

/**
 * Creates and configures the Express app.
 * @param {ReturnType<import('./config/getConfig').getConfig>} config
 * @returns {Promise<import('express').Express>}
 */
async function createApp(config) {
  const app = express();

  app.disable('x-powered-by');
  app.use(cors());
  app.use(createCompressionMiddleware());
  app.use(express.json({ limit: '2mb' }));

  // Simple HTTP Response Logging (disabled)
  // app.use((req, res, next) => {
  //   const originalSend = res.send;
  //   res.send = function(data) {
  //     const dataSize = Buffer.byteLength(JSON.stringify(data));
  //     console.log(`[HTTP Response] ${req.method} ${req.path} - Status: ${res.statusCode} - Size: ${dataSize} bytes`);
  //     return originalSend.call(this, data);
  //   };
  //   next();
  // });

  app.use(createHealthRouter());
  app.use(createPagesRouter({ templatesDir: config.templatesDir }));
  app.use(createMapsRouter({ dataDir: config.dataDir, staticDir: config.staticDir }));
  app.use(
    createAssetsRouter({
      secretKey: config.secretKey,
      projectRoot: config.projectRoot,
      staticDir: config.staticDir,
      chunkDir: config.chunkDir,
      manifestPath: config.manifestPath,
    })
  );

  app.use('/api', (req, res) => {
    res.status(404).json({
      error: 'Not Found',
      path: req.path,
    });
  });

  return app;
}

module.exports = { createApp };
