const express = require('express');
const fs = require('fs');
const path = require('path');

const { resolveUnderBaseDir } = require('../../utils/pathSafety');
const { signToken, verifyToken } = require('./tokenService');
const { loadManifest } = require('./manifestService');

/**
 * Converts a web path like `/static/assets/foo.png` into a path relative to project root.
 * Why: manifest.json uses `/static/...` keys, while we need filesystem paths.
 * @param {string} webPath
 * @returns {string}
 */
function webPathToProjectRelativePath(webPath) {
  const normalized = String(webPath).trim();
  if (!normalized.startsWith('/')) {
    return normalized;
  }

  // Input: '/static/assets/x.png' -> 'static/assets/x.png'
  if (normalized.startsWith('/static/')) {
    return normalized.slice(1);
  }

  // Fallback: strip leading slash.
  return normalized.slice(1);
}

/**
 * Converts a web path like `/static/assets/foo.png` into a path relative to `static/assets`.
 * Why: request_asset must enforce that only static assets are tokenized.
 * @param {string} webPath
 * @returns {{ok: true, relativePath: string} | {ok: false, reason: string}}
 */
function webPathToAssetsRelativePath(webPath) {
  const normalized = String(webPath).trim();

  // Input: '/static/assets/x.png' -> 'x.png'
  if (normalized.startsWith('/static/assets/')) {
    return { ok: true, relativePath: normalized.slice('/static/assets/'.length) };
  }

  return { ok: false, reason: 'Unauthorized path' };
}

/**
 * Creates the secure asset routes.
 * @param {{secretKey: string, projectRoot: string, staticDir: string, chunkDir: string, manifestPath: string}} deps
 * @returns {import('express').Router}
 */
function createAssetsRouter(deps) {
  const router = express.Router();

  const manifestResult = loadManifest({ manifestPath: deps.manifestPath });
  const manifest = manifestResult.ok ? manifestResult.manifest : {};

  router.post('/api/request_asset', (req, res) => {
    const assetPath = String(req.body?.path ?? '');
    if (!assetPath) {
      res.status(400).json({ error: 'No path provided' });
      return;
    }

    const baseAssetsDir = path.join(deps.staticDir, 'assets');
    const assetsRelative = webPathToAssetsRelativePath(assetPath);
    if (!assetsRelative.ok) {
      res.status(403).json({ error: assetsRelative.reason });
      return;
    }
    const resolved = resolveUnderBaseDir({
      baseDir: baseAssetsDir,
      userPath: assetsRelative.relativePath,
    });

    if (!resolved.ok) {
      res.status(403).json({ error: resolved.reason });
      return;
    }

    if (!manifest[assetPath]) {
      res.status(404).json({ error: 'Asset not found' });
      return;
    }

    const assetInfo = manifest[assetPath];
    const token = signToken({
      secretKey: deps.secretKey,
      payload: { path: assetPath, chunk_ids: assetInfo.chunk_ids, iat_ms: Date.now() },
      expiresInSeconds: 300,
    });

    res.json({
      token,
      chunk_ids: assetInfo.chunk_ids,
      total_size: assetInfo.total_size,
    });
  });

  router.post('/api/request_character_token', (req, res) => {
    const character = String(req.body?.character ?? '');
    if (!character) {
      res.status(400).json({ error: 'Character name is required' });
      return;
    }

    const charDir = path.join(deps.staticDir, 'assets', 'characters', character);
    if (!fs.existsSync(charDir)) {
      res.status(404).json({ error: 'Character not found' });
      return;
    }

    const token = signToken({
      secretKey: deps.secretKey,
      payload: { character },
      expiresInSeconds: 60,
    });

    res.json({ token });
  });

  router.post('/api/request_environment_token', (_req, res) => {
    const token = signToken({
      secretKey: deps.secretKey,
      payload: { type: 'environment' },
      expiresInSeconds: 60,
    });

    res.json({ token });
  });

  router.get('/api/asset/:token', (req, res) => {
    const token = String(req.params.token ?? '');
    const verified = verifyToken({ secretKey: deps.secretKey, token });
    if (!verified.ok) {
      res.status(verified.reason === 'Token expired' ? 401 : 403).send(verified.reason);
      return;
    }

    const payload = verified.payload;
    const assetPath = typeof payload.path === 'string' ? payload.path : '';
    if (!assetPath) {
      res.status(403).send('Invalid token');
      return;
    }

    const relativeFromRoot = webPathToProjectRelativePath(assetPath);
    const resolved = resolveUnderBaseDir({ baseDir: deps.projectRoot, userPath: relativeFromRoot });
    if (!resolved.ok) {
      res.status(403).send('Unauthorized path');
      return;
    }

    if (!fs.existsSync(resolved.fullPath)) {
      res.status(404).send('Asset not found');
      return;
    }

    res.sendFile(resolved.fullPath);
  });

  router.get('/api/asset_chunk/:token/:chunkId', (req, res) => {
    const token = String(req.params.token ?? '');
    const chunkId = String(req.params.chunkId ?? '');

    const verified = verifyToken({ secretKey: deps.secretKey, token });
    if (!verified.ok) {
      res.status(verified.reason === 'Token expired' ? 401 : 403).send(verified.reason);
      return;
    }

    const payload = verified.payload;

    // Enforce Python-like short window for chunk download usage.
    // Python uses max_age=30 seconds for chunk token.
    const iatMs = typeof payload.iat_ms === 'number' ? payload.iat_ms : 0;
    if (!iatMs || Date.now() - iatMs > 30_000) {
      res.status(401).send('Token expired');
      return;
    }

    const chunkIds = Array.isArray(payload.chunk_ids) ? payload.chunk_ids : [];
    if (!chunkIds.includes(chunkId)) {
      res.status(403).send('Unauthorized chunk');
      return;
    }

    const chunkPath = path.join(deps.chunkDir, `${chunkId}.bin`);
    if (!fs.existsSync(chunkPath)) {
      res.status(404).send('Chunk not found');
      return;
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    const stream = fs.createReadStream(chunkPath);
    stream.on('error', () => res.status(500).send('Server error'));
    stream.pipe(res);
  });

  router.get('/api/tileset/:token', (req, res) => {
    const token = String(req.params.token ?? '');
    const verified = verifyToken({ secretKey: deps.secretKey, token });
    if (!verified.ok) {
      res.status(403).send('<h1>Access Denied</h1>');
      return;
    }

    const tilesetPath = path.join(deps.staticDir, 'assets', 'tileset', 'tileset.png');
    if (!fs.existsSync(tilesetPath)) {
      res.status(404).send('<h1>Not Found</h1>');
      return;
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(tilesetPath);
  });

  router.get('/api/background/:token', (req, res) => {
    const token = String(req.params.token ?? '');
    const verified = verifyToken({ secretKey: deps.secretKey, token });
    if (!verified.ok) {
      res.status(403).send('<h1>Access Denied</h1>');
      return;
    }

    const bgPath = path.join(deps.staticDir, 'assets', 'tileset', 'background.png');
    if (!fs.existsSync(bgPath)) {
      res.status(404).send('<h1>Not Found</h1>');
      return;
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(bgPath);
  });

  router.get('/api/homescreen_video/:token', (req, res) => {
    const token = String(req.params.token ?? '');
    const verified = verifyToken({ secretKey: deps.secretKey, token });
    if (!verified.ok) {
      res.status(403).send('<h1>Access Denied</h1>');
      return;
    }

    const videoPath = path.join(deps.staticDir, 'assets', 'tileset', 'homescreen.mp4');
    if (!fs.existsSync(videoPath)) {
      res.status(404).send('<h1>Not Found</h1>');
      return;
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(videoPath);
  });

  router.get('/api/character_assets/:token/:character/:asset', (req, res) => {
    const token = String(req.params.token ?? '');
    const character = String(req.params.character ?? '');
    const asset = String(req.params.asset ?? '');

    const verified = verifyToken({ secretKey: deps.secretKey, token });
    if (!verified.ok) {
      res.status(403).send('<h1>Access Denied</h1>');
      return;
    }

    const payload = verified.payload;
    if (payload.character !== character) {
      res.status(403).send('<h1>Access Denied</h1>');
      return;
    }

    const assetPath = path.join(deps.staticDir, 'assets', 'characters', character, `${asset}.png`);
    if (!fs.existsSync(assetPath)) {
      res.status(404).send('<h1>Not Found</h1>');
      return;
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(assetPath);
  });

  router.get('/api/character_metadata/:character', (req, res) => {
    const character = String(req.params.character ?? '');
    const metadataPath = path.join(
      deps.staticDir,
      'assets',
      'characters',
      character,
      `metadata_${character}.json`
    );

    if (!fs.existsSync(metadataPath)) {
      res.status(404).send(`Character ${character} not found`);
      return;
    }

    try {
      const raw = fs.readFileSync(metadataPath, 'utf8');
      res.json(JSON.parse(raw));
    } catch {
      res.status(500).send('Server error');
    }
  });

  return router;
}

module.exports = { createAssetsRouter };
