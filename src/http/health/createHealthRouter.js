const express = require('express');
const fs = require('fs');
const path = require('path');

/**
 * Health check endpoint.
 * @returns {import('express').Router}
 */
function createHealthRouter() {
  const router = express.Router();

  // Root health check for compatibility with deployment platforms
  router.get('/', (_req, res) => {
    res.json({
      status: 'ok',
      timestamp: Math.floor(Date.now() / 1000),
    });
  });

  router.get('/health', (_req, res) => {
    const projectRoot = process.cwd();
    const dataDir = process.env.DATA_DIR ?? 'data';
    const defaultMapPath = path.resolve(dataDir, 'default.json');

    res.json({
      status: 'healthy',
      timestamp: Math.floor(Date.now() / 1000),
      version: '1.0.0',
      nodeEnv: process.env.NODE_ENV ?? 'development',
      renderServiceName: process.env.RENDER_SERVICE_NAME ?? null,
      renderGitCommit: process.env.RENDER_GIT_COMMIT ?? null,
      cwd: projectRoot,
      hasDefaultMap: fs.existsSync(defaultMapPath),
    });
  });

  return router;
}

module.exports = { createHealthRouter };
