const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { resolveUnderBaseDir } = require('../../utils/pathSafety');
const { signToken, verifyToken } = require('./tokenService');
const { loadManifest } = require('./manifestService');

function listAvailableCharacterCards(staticDir) {
  const characterDir = path.join(staticDir, 'assets', 'characters');
  const cardsDir = path.join(staticDir, 'assets', 'cards');

  let characterNames = [];
  let cardNames = new Set();

  try {
    characterNames = fs
      .readdirSync(characterDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    characterNames = [];
  }

  try {
    cardNames = new Set(
      fs
        .readdirSync(cardsDir, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.parse(entry.name).name.toLowerCase())
    );
  } catch {
    cardNames = new Set();
  }

  return characterNames
    .filter((character) => cardNames.has(`${character.toLowerCase()}a`))
    .sort()
    .map((character) => ({
      character,
      cardAsset: `${character}A`,
    }));
}

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
 * Verifies the browser asset session header.
 * Why: A token in the URL alone is easy to reuse in a new tab.
 * Requiring a matching header forces assets through the app's JS fetch flow.
 * @param {{secretKey: string, req: import('express').Request}} input
 * @returns {{ok: true, sessionId: string} | {ok: false, status: number, reason: string}}
 */
function verifyAssetSession(input) {
  const headerToken = String(input.req.get('x-asset-session') ?? '').trim();
  if (!headerToken) {
    return { ok: false, status: 403, reason: 'Access Denied' };
  }

  const verified = verifyToken({ secretKey: input.secretKey, token: headerToken });
  if (!verified.ok) {
    return {
      ok: false,
      status: verified.reason === 'Token expired' ? 401 : 403,
      reason: 'Access Denied',
    };
  }

  const payload = verified.payload;
  if (payload.type !== 'asset_session' || typeof payload.sid !== 'string' || !payload.sid) {
    return { ok: false, status: 403, reason: 'Access Denied' };
  }

  return { ok: true, sessionId: payload.sid };
}

/**
 * Ensures an asset token was minted for the active asset session.
 * @param {{payload: any, assetSessionId: string}} input
 * @returns {boolean}
 */
function tokenMatchesAssetSession(input) {
  return typeof input.payload?.asset_sid === 'string' && input.payload.asset_sid === input.assetSessionId;
}

/**
 * Sends binary data with anti-preview headers so raw clicks are less useful.
 * @param {{res: import('express').Response, fullPath: string, downloadName: string}} input
 */
function sendProtectedBinaryFile(input) {
  let stat;
  try {
    stat = fs.statSync(input.fullPath);
  } catch {
    input.res.status(404).send('Not Found');
    return;
  }

  input.res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  input.res.setHeader('Pragma', 'no-cache');
  input.res.setHeader('Expires', '0');
  input.res.setHeader('Content-Type', 'application/octet-stream');
  input.res.setHeader('X-Content-Type-Options', 'nosniff');
  input.res.setHeader('Content-Disposition', `attachment; filename="${path.basename(input.downloadName)}"`);
  input.res.setHeader('Content-Length', stat.size);

  const stream = fs.createReadStream(input.fullPath);
  stream.on('error', () => {
    if (!input.res.headersSent) {
      input.res.status(500).send('Server error');
      return;
    }
    input.res.destroy();
  });
  stream.pipe(input.res);
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
  const selectableCharacters = listAvailableCharacterCards(deps.staticDir);
  const publicMenuSounds = new Set(['click.wav', 'hover.wav', 'navigate.wav', 'play.wav', 'full.wav', 'set.wav']);

  router.post('/api/asset_session', (_req, res) => {
    const token = signToken({
      secretKey: deps.secretKey,
      payload: {
        type: 'asset_session',
        sid: crypto.randomBytes(24).toString('hex'),
      },
      expiresInSeconds: 86_400,
    });

    res.setHeader('Cache-Control', 'no-store');
    res.json({ token });
  });

  router.get('/audio/menu/:name', (req, res) => {
    const soundName = String(req.params.name ?? '').trim().toLowerCase();
    if (!publicMenuSounds.has(soundName)) {
      res.status(404).send('Not Found');
      return;
    }

    const soundPath = path.join(deps.staticDir, 'assets', 'sounds', soundName);
    if (!fs.existsSync(soundPath)) {
      res.status(404).send('Not Found');
      return;
    }

    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type(path.extname(soundName));
    res.sendFile(soundPath);
  });

  router.post('/api/request_asset', (req, res) => {
    const assetSession = verifyAssetSession({ secretKey: deps.secretKey, req });
    if (!assetSession.ok) {
      res.status(assetSession.status).json({ error: assetSession.reason });
      return;
    }

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
      payload: {
        path: assetPath,
        chunk_ids: assetInfo.chunk_ids,
        iat_ms: Date.now(),
        asset_sid: assetSession.sessionId,
      },
      expiresInSeconds: 300,
    });

    res.json({
      token,
      chunk_ids: assetInfo.chunk_ids,
      total_size: assetInfo.total_size,
    });
  });

  router.post('/api/request_character_token', (req, res) => {
    const assetSession = verifyAssetSession({ secretKey: deps.secretKey, req });
    if (!assetSession.ok) {
      res.status(assetSession.status).json({ error: assetSession.reason });
      return;
    }

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
      payload: { character, asset_sid: assetSession.sessionId },
      expiresInSeconds: 60,
    });

    res.json({ token });
  });

  router.get('/api/character_selection_manifest', (req, res) => {
    const assetSession = verifyAssetSession({ secretKey: deps.secretKey, req });
    if (!assetSession.ok) {
      res.status(assetSession.status).json({ error: assetSession.reason });
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({ characters: selectableCharacters });
  });

  router.post('/api/request_character_card_token', (req, res) => {
    const assetSession = verifyAssetSession({ secretKey: deps.secretKey, req });
    if (!assetSession.ok) {
      res.status(assetSession.status).json({ error: assetSession.reason });
      return;
    }

    const character = String(req.body?.character ?? '').trim().toLowerCase();
    const selection = selectableCharacters.find((entry) => entry.character === character);
    if (!selection) {
      res.status(404).json({ error: 'Character card not found' });
      return;
    }

    const token = signToken({
      secretKey: deps.secretKey,
      payload: {
        type: 'character_card',
        character,
        asset_sid: assetSession.sessionId,
      },
      expiresInSeconds: 60,
    });

    res.json({ token });
  });

  router.post('/api/request_environment_token', (req, res) => {
    const assetSession = verifyAssetSession({ secretKey: deps.secretKey, req });
    if (!assetSession.ok) {
      res.status(assetSession.status).json({ error: assetSession.reason });
      return;
    }

    const token = signToken({
      secretKey: deps.secretKey,
      payload: { type: 'environment', asset_sid: assetSession.sessionId },
      expiresInSeconds: 60,
    });

    res.json({ token });
  });

  router.get('/api/asset/:token', (req, res) => {
    const assetSession = verifyAssetSession({ secretKey: deps.secretKey, req });
    if (!assetSession.ok) {
      res.status(assetSession.status).send(assetSession.reason);
      return;
    }

    const token = String(req.params.token ?? '');
    const verified = verifyToken({ secretKey: deps.secretKey, token });
    if (!verified.ok) {
      res.status(verified.reason === 'Token expired' ? 401 : 403).send(verified.reason);
      return;
    }

    const payload = verified.payload;
    if (!tokenMatchesAssetSession({ payload, assetSessionId: assetSession.sessionId })) {
      res.status(403).send('Access Denied');
      return;
    }

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

    sendProtectedBinaryFile({
      res,
      fullPath: resolved.fullPath,
      downloadName: path.basename(resolved.fullPath),
    });
  });

  router.get('/api/asset_chunk/:token/:chunkId', (req, res) => {
    const assetSession = verifyAssetSession({ secretKey: deps.secretKey, req });
    if (!assetSession.ok) {
      res.status(assetSession.status).send(assetSession.reason);
      return;
    }

    const token = String(req.params.token ?? '');
    const chunkId = String(req.params.chunkId ?? '');

    const verified = verifyToken({ secretKey: deps.secretKey, token });
    if (!verified.ok) {
      res.status(verified.reason === 'Token expired' ? 401 : 403).send(verified.reason);
      return;
    }

    const payload = verified.payload;
    if (!tokenMatchesAssetSession({ payload, assetSessionId: assetSession.sessionId })) {
      res.status(403).send('Access Denied');
      return;
    }

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

    sendProtectedBinaryFile({
      res,
      fullPath: chunkPath,
      downloadName: `${chunkId}.bin`,
    });
  });

  router.get('/api/tileset/:token', (req, res) => {
    const assetSession = verifyAssetSession({ secretKey: deps.secretKey, req });
    if (!assetSession.ok) {
      res.status(assetSession.status).send('<h1>Access Denied</h1>');
      return;
    }

    const token = String(req.params.token ?? '');
    const verified = verifyToken({ secretKey: deps.secretKey, token });
    if (!verified.ok) {
      res.status(403).send('<h1>Access Denied</h1>');
      return;
    }

    if (
      verified.payload.type !== 'environment' ||
      !tokenMatchesAssetSession({ payload: verified.payload, assetSessionId: assetSession.sessionId })
    ) {
      res.status(403).send('<h1>Access Denied</h1>');
      return;
    }

    const tilesetPath = path.join(deps.staticDir, 'assets', 'tileset', 'tileset.png');
    if (!fs.existsSync(tilesetPath)) {
      res.status(404).send('<h1>Not Found</h1>');
      return;
    }

    sendProtectedBinaryFile({
      res,
      fullPath: tilesetPath,
      downloadName: 'tileset.png',
    });
  });

  router.get('/api/background/:token', (req, res) => {
    const assetSession = verifyAssetSession({ secretKey: deps.secretKey, req });
    if (!assetSession.ok) {
      res.status(assetSession.status).send('<h1>Access Denied</h1>');
      return;
    }

    const token = String(req.params.token ?? '');
    const verified = verifyToken({ secretKey: deps.secretKey, token });
    if (!verified.ok) {
      res.status(403).send('<h1>Access Denied</h1>');
      return;
    }

    if (
      verified.payload.type !== 'environment' ||
      !tokenMatchesAssetSession({ payload: verified.payload, assetSessionId: assetSession.sessionId })
    ) {
      res.status(403).send('<h1>Access Denied</h1>');
      return;
    }

    const bgPath = path.join(deps.staticDir, 'assets', 'tileset', 'background.png');
    if (!fs.existsSync(bgPath)) {
      res.status(404).send('<h1>Not Found</h1>');
      return;
    }

    sendProtectedBinaryFile({
      res,
      fullPath: bgPath,
      downloadName: 'background.png',
    });
  });

  router.get('/api/homescreen_video/:token', (req, res) => {
    const assetSession = verifyAssetSession({ secretKey: deps.secretKey, req });
    if (!assetSession.ok) {
      res.status(assetSession.status).send('<h1>Access Denied</h1>');
      return;
    }

    const token = String(req.params.token ?? '');
    const verified = verifyToken({ secretKey: deps.secretKey, token });
    if (!verified.ok) {
      res.status(403).send('<h1>Access Denied</h1>');
      return;
    }

    if (
      verified.payload.type !== 'environment' ||
      !tokenMatchesAssetSession({ payload: verified.payload, assetSessionId: assetSession.sessionId })
    ) {
      res.status(403).send('<h1>Access Denied</h1>');
      return;
    }

    const videoPath = path.join(deps.staticDir, 'assets', 'tileset', 'homescreen.mp4');
    if (!fs.existsSync(videoPath)) {
      res.status(404).send('<h1>Not Found</h1>');
      return;
    }

    sendProtectedBinaryFile({
      res,
      fullPath: videoPath,
      downloadName: 'homescreen.mp4',
    });
  });

  router.get('/api/character_assets/:token/:character/:asset', (req, res) => {
    const assetSession = verifyAssetSession({ secretKey: deps.secretKey, req });
    if (!assetSession.ok) {
      res.status(assetSession.status).send('<h1>Access Denied</h1>');
      return;
    }

    const token = String(req.params.token ?? '');
    const character = String(req.params.character ?? '');
    const asset = String(req.params.asset ?? '');

    const verified = verifyToken({ secretKey: deps.secretKey, token });
    if (!verified.ok) {
      res.status(403).send('<h1>Access Denied</h1>');
      return;
    }

    const payload = verified.payload;
    if (
      payload.character !== character ||
      !tokenMatchesAssetSession({ payload, assetSessionId: assetSession.sessionId })
    ) {
      res.status(403).send('<h1>Access Denied</h1>');
      return;
    }

    const assetPath = path.join(deps.staticDir, 'assets', 'characters', character, `${asset}.png`);
    if (!fs.existsSync(assetPath)) {
      res.status(404).send('<h1>Not Found</h1>');
      return;
    }

    sendProtectedBinaryFile({
      res,
      fullPath: assetPath,
      downloadName: `${character}_${asset}.png`,
    });
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

  router.get('/api/character_card/:token/:character', (req, res) => {
    const assetSession = verifyAssetSession({ secretKey: deps.secretKey, req });
    if (!assetSession.ok) {
      res.status(assetSession.status).send('<h1>Access Denied</h1>');
      return;
    }

    const token = String(req.params.token ?? '');
    const character = String(req.params.character ?? '').trim().toLowerCase();

    const verified = verifyToken({ secretKey: deps.secretKey, token });
    if (!verified.ok) {
      res.status(403).send('<h1>Access Denied</h1>');
      return;
    }

    const payload = verified.payload;
    if (
      payload.type !== 'character_card' ||
      payload.character !== character ||
      !tokenMatchesAssetSession({ payload, assetSessionId: assetSession.sessionId })
    ) {
      res.status(403).send('<h1>Access Denied</h1>');
      return;
    }

    const selection = selectableCharacters.find((entry) => entry.character === character);
    if (!selection) {
      res.status(404).send('<h1>Not Found</h1>');
      return;
    }

    const assetPath = path.join(deps.staticDir, 'assets', 'cards', `${selection.cardAsset}.png`);
    if (!fs.existsSync(assetPath)) {
      res.status(404).send('<h1>Not Found</h1>');
      return;
    }

    sendProtectedBinaryFile({
      res,
      fullPath: assetPath,
      downloadName: `${selection.cardAsset}.png`,
    });
  });

  return router;
}

module.exports = { createAssetsRouter };
