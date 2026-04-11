const express = require('express');
const path = require('path');

/**
 * Creates routes for server-rendered pages.
 * We use sendFile to keep the current HTML templates unchanged.
 * @param {{templatesDir: string}} deps
 * @returns {import('express').Router}
 */
function createPagesRouter(deps) {
  const router = express.Router();

  router.get('/', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.sendFile(path.join(deps.templatesDir, 'index.html'));
  });

  router.get('/editor', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.sendFile(path.join(deps.templatesDir, 'editor.html'));
  });

  router.get('/enhancer', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.sendFile(path.join(deps.templatesDir, 'enhancer.html'));
  });

  return router;
}

module.exports = { createPagesRouter };
