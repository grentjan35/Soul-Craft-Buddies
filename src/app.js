const express = require('express');
const cors = require('cors');

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
  app.use(express.json({ limit: '2mb' }));

  app.use(createHealthRouter());
  app.use(createPagesRouter({ templatesDir: config.templatesDir }));
  app.use(createMapsRouter({ dataDir: config.dataDir }));
  app.use(
    createAssetsRouter({
      secretKey: config.secretKey,
      projectRoot: config.projectRoot,
      staticDir: config.staticDir,
      chunkDir: config.chunkDir,
      manifestPath: config.manifestPath,
    })
  );

  return app;
}

module.exports = { createApp };
