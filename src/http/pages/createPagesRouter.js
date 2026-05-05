const express = require('express');
const path = require('path');
const fs = require('fs');

/**
 * Creates routes for server-rendered pages.
 * We use sendFile to keep the current HTML templates unchanged.
 * @param {{templatesDir: string, staticDir: string}} deps
 * @returns {import('express').Router}
 */
function createPagesRouter(deps) {
  const router = express.Router();

  // Public favicon routes - no token required
  const faviconDir = path.join(deps.staticDir, 'assets', 'general', 'favicon');

  router.get('/favicon.ico', (_req, res) => {
    const faviconPath = path.join(faviconDir, 'favicon.ico');
    if (!fs.existsSync(faviconPath)) {
      res.status(404).send('Not Found');
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.type('image/x-icon');
    res.sendFile(faviconPath);
  });

  router.get('/favicon-16x16.png', (_req, res) => {
    const iconPath = path.join(faviconDir, 'favicon-16x16.png');
    if (!fs.existsSync(iconPath)) {
      res.status(404).send('Not Found');
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.type('image/png');
    res.sendFile(iconPath);
  });

  router.get('/favicon-32x32.png', (_req, res) => {
    const iconPath = path.join(faviconDir, 'favicon-32x32.png');
    if (!fs.existsSync(iconPath)) {
      res.status(404).send('Not Found');
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.type('image/png');
    res.sendFile(iconPath);
  });

  router.get('/apple-touch-icon.png', (_req, res) => {
    const iconPath = path.join(faviconDir, 'apple-touch-icon.png');
    if (!fs.existsSync(iconPath)) {
      res.status(404).send('Not Found');
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.type('image/png');
    res.sendFile(iconPath);
  });

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

  router.get('/msgpack.min.js', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.type('application/javascript');
    res.sendFile(path.join(deps.staticDir, 'msgpack.min.js'));
  });

  // Serve roll assets
  router.get('/static/assets/characters/metadata_roll.json', (_req, res) => {
    const metadataPath = path.join(deps.staticDir, 'assets', 'characters', 'metadata_roll.json');
    if (!fs.existsSync(metadataPath)) {
      res.status(404).send('Not Found');
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.type('application/json');
    res.sendFile(metadataPath);
  });

  router.get('/static/assets/characters/roll.webp', (_req, res) => {
    const rollPath = path.join(deps.staticDir, 'assets', 'characters', 'roll.webp');
    if (!fs.existsSync(rollPath)) {
      res.status(404).send('Not Found');
      return;
    }
    res.setHeader('Cache-Control', 'public, max-age=604800');
    res.type('image/webp');
    res.sendFile(rollPath);
  });

  // WebSocket monitor page
  router.get('/websocket-monitor', (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
    res.sendFile(path.join(deps.staticDir, 'websocket-monitor.html'));
  });

  return router;
}

module.exports = { createPagesRouter };
