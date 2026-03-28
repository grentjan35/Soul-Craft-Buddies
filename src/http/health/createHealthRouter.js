const express = require('express');

/**
 * Health check endpoint.
 * @returns {import('express').Router}
 */
function createHealthRouter() {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({
      status: 'healthy',
      timestamp: Math.floor(Date.now() / 1000),
      version: '1.0.0',
    });
  });

  return router;
}

module.exports = { createHealthRouter };
