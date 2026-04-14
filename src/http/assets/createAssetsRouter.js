const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { loadEnemyCatalog, loadEnemyMetadata, saveEnemyMetadata } = require('../../enemies/catalog');
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

function listAvailableBackgrounds(staticDir) {
  const tilesetDir = path.join(staticDir, 'assets', 'tileset');

  try {
    return fs
      .readdirSync(tilesetDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^background_\d+\.png$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => {
        const aNum = Number(a.match(/\d+/)?.[0] ?? 0);
        const bNum = Number(b.match(/\d+/)?.[0] ?? 0);
        return aNum - bNum || a.localeCompare(b);
      });
  } catch {
    return [];
  }
}

function listAvailableBackgroundCompanions(staticDir) {
  const tilesetDir = path.join(staticDir, 'assets', 'tileset');

  try {
    const filenames = fs
      .readdirSync(tilesetDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);

    const filenameSet = new Set(filenames);
    const companionByBackground = {};

    filenames
      .filter((name) => /^background_\d+\.png$/i.test(name))
      .forEach((backgroundName) => {
        const index = backgroundName.match(/(\d+)/)?.[1];
        if (!index) {
          return;
        }

        const preferredForeground = `foreground_${index}.png`;
        const fallbackForeground = `farground_${index}.png`;

        if (filenameSet.has(preferredForeground)) {
          companionByBackground[backgroundName] = preferredForeground;
          return;
        }

        if (filenameSet.has(fallbackForeground)) {
          companionByBackground[backgroundName] = fallbackForeground;
        }
      });

    return companionByBackground;
  } catch {
    return {};
  }
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

function setPublicAssetCacheHeaders(res) {
  res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
}

function buildFileLookup(baseDir, relativeDir, allowedNames) {
  /** @type {Map<string, string>} */
  const lookup = new Map();

  for (const name of allowedNames) {
    const normalizedName = String(name).trim().toLowerCase();
    if (!normalizedName) {
      continue;
    }

    const fullPath = path.join(baseDir, relativeDir, normalizedName);
    try {
      if (fs.statSync(fullPath).isFile()) {
        lookup.set(normalizedName, fullPath);
      }
    } catch {
      // Ignore missing optional assets and keep startup resilient.
    }
  }

  return lookup;
}

function sendPublicCachedFile(res, lookup, assetName) {
  const fullPath = lookup.get(String(assetName).trim().toLowerCase());
  if (!fullPath) {
    res.status(404).send('Not Found');
    return;
  }

  setPublicAssetCacheHeaders(res);
  res.type(path.extname(fullPath));
  res.sendFile(fullPath);
}

function buildExternalAssetUrl(baseUrl, relativeAssetPath) {
  const normalizedBase = String(baseUrl ?? '').trim().replace(/\/+$/, '');
  const normalizedRelative = String(relativeAssetPath ?? '')
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  if (!normalizedBase || !normalizedRelative) {
    return '';
  }

  return `${normalizedBase}/assets/${normalizedRelative}`;
}

function redirectToExternalAssetIfConfigured(res, baseUrl, relativeAssetPath) {
  const externalUrl = buildExternalAssetUrl(baseUrl, relativeAssetPath);
  if (!externalUrl) {
    return false;
  }

  res.redirect(302, externalUrl);
  return true;
}

async function sendExternalBinaryFile(res, baseUrl, relativeAssetPath, downloadName = '', options = {}) {
  const externalUrl = buildExternalAssetUrl(baseUrl, relativeAssetPath);
  if (!externalUrl) {
    return false;
  }

  let response;
  try {
    response = await fetch(externalUrl, {
      redirect: 'follow',
      cache: 'no-store',
    });
  } catch {
    return false;
  }

  if (!response.ok) {
    return false;
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  const contentType = response.headers.get('content-type') || 'application/octet-stream';

  if (options.protectedResponse) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (downloadName) {
      res.setHeader('Content-Disposition', `attachment; filename="${path.basename(downloadName)}"`);
    }
  } else {
    res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
    res.setHeader('Content-Type', contentType);
    if (downloadName) {
      res.setHeader('Content-Disposition', `inline; filename="${path.basename(downloadName)}"`);
    }
  }
  res.setHeader('Content-Length', Buffer.byteLength(buffer));
  res.send(buffer);
  return true;
}

/**
 * Creates the secure asset routes.
 * @param {{secretKey: string, projectRoot: string, staticDir: string, manifestPath: string, assetCdnBaseUrl: string}} deps
 * @returns {import('express').Router}
 */
function createAssetsRouter(deps) {
  const router = express.Router();

  const manifestResult = loadManifest({ manifestPath: deps.manifestPath });
  const manifest = manifestResult.ok ? manifestResult.manifest : {};
  const selectableCharacters = listAvailableCharacterCards(deps.staticDir);
  const selectableBackgrounds = listAvailableBackgrounds(deps.staticDir);
  const backgroundCompanions = listAvailableBackgroundCompanions(deps.staticDir);
  const listEnemyCatalog = () => loadEnemyCatalog({ staticDir: deps.staticDir });
  const publicMenuSounds = new Set(['click.wav', 'hover.wav', 'navigate.wav', 'play.wav', 'full.wav', 'set.wav']);
  const publicFootstepPattern = /^footsteps_[1-3]\.wav$/;
  const publicSpiderFootstepPattern = /^footstep([2-4])?\.mp3$/;
  const publicSlimeFootstepPattern = /^footstep(\s\((2|3)\))?\.mp3$/;
  const publicGameplaySounds = new Set(['fall.wav', 'fire.wav', 'combat.mp3', 'soul_collected.mp3']);
  const publicFireballSounds = new Set(['hit.wav', 'inair.wav', 'release.wav']);
  const publicPlayerHurtPattern = /^hurt[1-5]?\.mp3$/;
  const publicSpiderSounds = new Set([
    'death.mp3',
    'death2.mp3',
    'eating.mp3',
    'growl.mp3',
    'growling.mp3',
    'hurt.mp3',
    'screeching.mp3',
    'throwing up.mp3',
    'wine.mp3',
  ]);
  const publicBatSounds = new Set([
    'death.mp3',
    'detect.mp3',
    'flying.mp3',
    'hurt.mp3',
    'idle.mp3',
    'wander.mp3',
    'wandering.mp3',
  ]);
  const publicSlimeSounds = new Set([
    'attack.mp3',
    'death.mp3',
    'growl.mp3',
    'hurt.mp3',
    'wander.mp3',
  ]);
  const publicGargoyleSounds = new Set([
    'attack.mp3',
    'flying.mp3',
    'idle.mp3',
    'not in combat.mp3',
    'swoop.mp3',
  ]);
  const publicStrikerSounds = new Set([
    'attack.mp3',
    'death.mp3',
    'flying.mp3',
    'hurt.mp3',
    'idle.mp3',
    'slam.mp3',
  ]);
  const publicMenuSoundFiles = buildFileLookup(deps.staticDir, path.join('assets', 'sounds'), publicMenuSounds);
  const publicGameplaySoundFiles = buildFileLookup(deps.staticDir, path.join('assets', 'sounds'), publicGameplaySounds);
  const publicFireballSoundFiles = buildFileLookup(deps.staticDir, path.join('assets', 'sounds', 'fireball'), publicFireballSounds);
  const publicSpiderSoundFiles = buildFileLookup(deps.staticDir, path.join('assets', 'sounds', 'spider'), publicSpiderSounds);
  const publicBatSoundFiles = buildFileLookup(deps.staticDir, path.join('assets', 'sounds', 'bat'), publicBatSounds);
  const publicSlimeSoundFiles = buildFileLookup(deps.staticDir, path.join('assets', 'sounds', 'slime'), publicSlimeSounds);
  const publicGargoyleSoundFiles = buildFileLookup(deps.staticDir, path.join('assets', 'sounds', 'gargoyle'), publicGargoyleSounds);
  const publicStrikerSoundFiles = buildFileLookup(deps.staticDir, path.join('assets', 'sounds', 'striker'), publicStrikerSounds);
  const publicGuiAssets = new Set(['jump_button.png', 'play.png']);
  const publicGuiAssetFiles = buildFileLookup(deps.staticDir, path.join('assets', 'GUI'), publicGuiAssets);
  const guiAlphabetLookup = new Map();

  try {
    const alphabetDir = path.join(deps.staticDir, 'assets', 'GUI', 'alphabet');
    for (const entry of fs.readdirSync(alphabetDir, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }

      const glyphName = path.parse(entry.name).name.trim().toUpperCase();
      if (!glyphName) {
        continue;
      }

      guiAlphabetLookup.set(glyphName, path.join(alphabetDir, entry.name));
    }
  } catch {
    // Alphabet is optional at startup; requests will 404 if absent.
  }

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

  router.get('/api/gui/alphabet/:letter', async (req, res) => {
    const assetSession = verifyAssetSession({ secretKey: deps.secretKey, req });
    if (!assetSession.ok) {
      res.status(assetSession.status).send('<h1>Access Denied</h1>');
      return;
    }

    const letter = String(req.params.letter ?? '').trim().toUpperCase();
    const letterPath = guiAlphabetLookup.get(letter);
    if (!letterPath) {
      res.status(404).send('Not Found');
      return;
    }

    const filename = path.basename(letterPath);
    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('GUI', 'alphabet', filename), `${letter}.png`, { protectedResponse: true })) {
      return;
    }

    sendProtectedBinaryFile({
      res,
      fullPath: letterPath,
      downloadName: `${letter}.png`,
    });
  });

  router.get('/api/gui/font_spritesheet', async (req, res) => {
    const assetSession = verifyAssetSession({ secretKey: deps.secretKey, req });
    if (!assetSession.ok) {
      res.status(assetSession.status).send('<h1>Access Denied</h1>');
      return;
    }

    const spritesheetPath = path.join(deps.staticDir, 'assets', 'GUI', 'font_spritesheet.png');
    if (!fs.existsSync(spritesheetPath)) {
      res.status(404).send('<h1>Not Found</h1>');
      return;
    }

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('GUI', 'font_spritesheet.png'), 'font_spritesheet.png', { protectedResponse: true })) {
      return;
    }

    sendProtectedBinaryFile({
      res,
      fullPath: spritesheetPath,
      downloadName: 'font_spritesheet.png',
    });
  });

  router.get('/audio/menu/:name', async (req, res) => {
    const soundName = String(req.params.name ?? '').trim().toLowerCase();
    if (!publicMenuSounds.has(soundName)) {
      res.status(404).send('Not Found');
      return;
    }

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('sounds', soundName), soundName)) {
      return;
    }

    sendPublicCachedFile(res, publicMenuSoundFiles, soundName);
  });

  router.get('/audio/footsteps/:name', async (req, res) => {
    const soundName = String(req.params.name ?? '').trim().toLowerCase();
    if (!publicFootstepPattern.test(soundName)) {
      res.status(404).send('Not Found');
      return;
    }

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('sounds', 'footsteps', soundName), soundName)) {
      return;
    }

    const soundPath = path.join(deps.staticDir, 'assets', 'sounds', 'footsteps', soundName);
    try {
      if (!fs.statSync(soundPath).isFile()) {
        res.status(404).send('Not Found');
        return;
      }
    } catch {
      res.status(404).send('Not Found');
      return;
    }

    setPublicAssetCacheHeaders(res);
    res.type(path.extname(soundName));
    res.sendFile(soundPath);
  });

  router.get('/audio/spider_footsteps/:name', async (req, res) => {
    const soundName = String(req.params.name ?? '').trim().toLowerCase();
    if (!publicSpiderFootstepPattern.test(soundName)) {
      res.status(404).send('Not Found');
      return;
    }

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('sounds', 'footsteps', 'spider footsteps', soundName), soundName)) {
      return;
    }

    const soundPath = path.join(deps.staticDir, 'assets', 'sounds', 'footsteps', 'spider footsteps', soundName);
    try {
      if (!fs.statSync(soundPath).isFile()) {
        res.status(404).send('Not Found');
        return;
      }
    } catch {
      res.status(404).send('Not Found');
      return;
    }

    setPublicAssetCacheHeaders(res);
    res.type(path.extname(soundName));
    res.sendFile(soundPath);
  });

  router.get('/audio/slime_footsteps/:name', async (req, res) => {
    const soundName = String(req.params.name ?? '').trim().toLowerCase();
    if (!publicSlimeFootstepPattern.test(soundName)) {
      res.status(404).send('Not Found');
      return;
    }

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('sounds', 'footsteps', 'slime footsteps', soundName), soundName)) {
      return;
    }

    const soundPath = path.join(deps.staticDir, 'assets', 'sounds', 'footsteps', 'slime footsteps', soundName);
    try {
      if (!fs.statSync(soundPath).isFile()) {
        res.status(404).send('Not Found');
        return;
      }
    } catch {
      res.status(404).send('Not Found');
      return;
    }

    setPublicAssetCacheHeaders(res);
    res.type(path.extname(soundName));
    res.sendFile(soundPath);
  });

  router.get('/audio/:name', async (req, res) => {
    const soundName = String(req.params.name ?? '').trim().toLowerCase();
    if (!publicGameplaySounds.has(soundName)) {
      res.status(404).send('Not Found');
      return;
    }

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('sounds', soundName), soundName)) {
      return;
    }

    sendPublicCachedFile(res, publicGameplaySoundFiles, soundName);
  });

  router.get('/audio/fireball/:name', async (req, res) => {
    const soundName = String(req.params.name ?? '').trim().toLowerCase();
    if (!publicFireballSounds.has(soundName)) {
      res.status(404).send('Not Found');
      return;
    }

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('sounds', 'fireball', soundName), soundName)) {
      return;
    }

    sendPublicCachedFile(res, publicFireballSoundFiles, soundName);
  });

  router.get('/audio/hurt/:name', async (req, res) => {
    const soundName = String(req.params.name ?? '').trim().toLowerCase();
    if (!publicPlayerHurtPattern.test(soundName)) {
      res.status(404).send('Not Found');
      return;
    }

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('sounds', 'hurt', soundName), soundName)) {
      return;
    }

    const soundPath = path.join(deps.staticDir, 'assets', 'sounds', 'hurt', soundName);
    if (!fs.existsSync(soundPath)) {
      res.status(404).send('Not Found');
      return;
    }

    setPublicAssetCacheHeaders(res);
    res.type(path.extname(soundName));
    res.sendFile(soundPath);
  });

  router.get('/audio/spider/:name', async (req, res) => {
    const soundName = String(req.params.name ?? '').trim().toLowerCase();
    if (!publicSpiderSounds.has(soundName)) {
      res.status(404).send('Not Found');
      return;
    }

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('sounds', 'spider', soundName), soundName)) {
      return;
    }

    sendPublicCachedFile(res, publicSpiderSoundFiles, soundName);
  });

  router.get('/audio/bat/:name', async (req, res) => {
    const soundName = String(req.params.name ?? '').trim().toLowerCase();
    if (!publicBatSounds.has(soundName)) {
      res.status(404).send('Not Found');
      return;
    }

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('sounds', 'bat', soundName), soundName)) {
      return;
    }

    sendPublicCachedFile(res, publicBatSoundFiles, soundName);
  });

  router.get('/audio/slime/:name', async (req, res) => {
    const soundName = String(req.params.name ?? '').trim().toLowerCase();
    if (!publicSlimeSounds.has(soundName)) {
      res.status(404).send('Not Found');
      return;
    }

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('sounds', 'slime', soundName), soundName)) {
      return;
    }

    sendPublicCachedFile(res, publicSlimeSoundFiles, soundName);
  });

  router.get('/audio/gargoyle/:name', async (req, res) => {
    const soundName = String(req.params.name ?? '').trim().toLowerCase();
    if (!publicGargoyleSounds.has(soundName)) {
      res.status(404).send('Not Found');
      return;
    }

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('sounds', 'gargoyle', soundName), soundName)) {
      return;
    }

    sendPublicCachedFile(res, publicGargoyleSoundFiles, soundName);
  });

  router.get('/audio/striker/:name', async (req, res) => {
    const soundName = String(req.params.name ?? '').trim().toLowerCase();
    if (!publicStrikerSounds.has(soundName)) {
      res.status(404).send('Not Found');
      return;
    }

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('sounds', 'striker', soundName), soundName)) {
      return;
    }

    sendPublicCachedFile(res, publicStrikerSoundFiles, soundName);
  });

  router.get('/gui/:name', async (req, res) => {
    const assetName = String(req.params.name ?? '').trim().toLowerCase();
    if (!publicGuiAssets.has(assetName)) {
      res.status(404).send('Not Found');
      return;
    }

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('GUI', assetName), assetName)) {
      return;
    }

    sendPublicCachedFile(res, publicGuiAssetFiles, assetName);
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
        iat_ms: Date.now(),
        asset_sid: assetSession.sessionId,
      },
      expiresInSeconds: 300,
    });

    res.json({
      token,
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

  router.post('/api/request_enemy_token', (req, res) => {
    const assetSession = verifyAssetSession({ secretKey: deps.secretKey, req });
    if (!assetSession.ok) {
      res.status(assetSession.status).json({ error: assetSession.reason });
      return;
    }

    const enemyType = String(req.body?.enemyType ?? req.body?.type ?? '').trim().toLowerCase();
    if (!enemyType) {
      res.status(400).json({ error: 'Enemy type is required' });
      return;
    }

    const enemyDir = path.join(deps.staticDir, 'assets', 'enemies', enemyType);
    if (!fs.existsSync(enemyDir)) {
      res.status(404).json({ error: 'Enemy not found' });
      return;
    }

    const token = signToken({
      secretKey: deps.secretKey,
      payload: {
        type: 'enemy',
        enemyType,
        asset_sid: assetSession.sessionId,
      },
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
    res.json({
      characters: selectableCharacters.map((entry) => ({
        character: entry.character,
        card_url: `/api/character_card_preview/${entry.character}`,
      })),
    });
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

  router.get('/api/asset/:token', async (req, res) => {
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
    const resolved = resolveUnderBaseDir({ baseDir: deps.staticDir, userPath: relativeFromRoot });
    if (!resolved.ok) {
      res.status(403).send('Unauthorized path');
      return;
    }

    if (!fs.existsSync(resolved.fullPath)) {
      res.status(404).send('Asset not found');
      return;
    }

    const relativeFromAssets = path.relative(path.join(deps.staticDir, 'assets'), resolved.fullPath);
    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, relativeFromAssets, path.basename(resolved.fullPath), { protectedResponse: true })) {
      return;
    }

    sendProtectedBinaryFile({
      res,
      fullPath: resolved.fullPath,
      downloadName: path.basename(resolved.fullPath),
    });
  });

  router.get('/api/tileset/:token', async (req, res) => {
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

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('tileset', 'tileset.png'), 'tileset.png', { protectedResponse: true })) {
      return;
    }

    sendProtectedBinaryFile({
      res,
      fullPath: tilesetPath,
      downloadName: 'tileset.png',
    });
  });

  router.get('/api/background/:token', async (req, res) => {
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

    const candidateNames = ['background_1.png', 'background.png'];
    const bgPath = candidateNames
      .map((name) => path.join(deps.staticDir, 'assets', 'tileset', name))
      .find((fullPath) => fs.existsSync(fullPath));

    if (!bgPath || !fs.existsSync(bgPath)) {
      res.status(404).send('<h1>Not Found</h1>');
      return;
    }

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('tileset', path.basename(bgPath)), path.basename(bgPath), { protectedResponse: true })) {
      return;
    }

    sendProtectedBinaryFile({
      res,
      fullPath: bgPath,
      downloadName: path.basename(bgPath),
    });
  });

  router.get('/api/backgrounds/:token', (req, res) => {
    const assetSession = verifyAssetSession({ secretKey: deps.secretKey, req });
    if (!assetSession.ok) {
      res.status(assetSession.status).json({ error: 'Access Denied' });
      return;
    }

    const token = String(req.params.token ?? '');
    const verified = verifyToken({ secretKey: deps.secretKey, token });
    if (!verified.ok) {
      res.status(403).json({ error: 'Access Denied' });
      return;
    }

    if (
      verified.payload.type !== 'environment' ||
      !tokenMatchesAssetSession({ payload: verified.payload, assetSessionId: assetSession.sessionId })
    ) {
      res.status(403).json({ error: 'Access Denied' });
      return;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      backgrounds: selectableBackgrounds,
      backgroundCompanions,
    });
  });

  router.get('/api/background_asset/:token/:filename', async (req, res) => {
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

    const filename = path.basename(String(req.params.filename ?? ''));
    const isSelectableBackground = /^background_\d+\.png$/i.test(filename) && selectableBackgrounds.includes(filename);
    const isKnownCompanion = Object.values(backgroundCompanions).includes(filename);

    if (!isSelectableBackground && !isKnownCompanion) {
      res.status(404).send('<h1>Not Found</h1>');
      return;
    }

    const bgPath = path.join(deps.staticDir, 'assets', 'tileset', filename);
    if (!fs.existsSync(bgPath)) {
      res.status(404).send('<h1>Not Found</h1>');
      return;
    }

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('tileset', filename), filename, { protectedResponse: true })) {
      return;
    }

    sendProtectedBinaryFile({
      res,
      fullPath: bgPath,
      downloadName: filename,
    });
  });

  router.get('/api/projectile_asset/:token/:projectile/:filename', async (req, res) => {
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

    const projectileName = path.basename(String(req.params.projectile ?? ''));
    const filename = path.basename(String(req.params.filename ?? ''));
    const allowedProjectile = projectileName === 'fireball';
    const allowedFiles = new Set(['fireball.png', 'explode.png', 'metadata_fireball.json']);

    if (!allowedProjectile || !allowedFiles.has(filename)) {
      res.status(404).send('<h1>Not Found</h1>');
      return;
    }

    const projectilePath = path.join(deps.staticDir, 'assets', 'projectiles', projectileName, filename);
    if (!fs.existsSync(projectilePath)) {
      res.status(404).send('<h1>Not Found</h1>');
      return;
    }

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('projectiles', projectileName, filename), filename, { protectedResponse: true })) {
      return;
    }

    sendProtectedBinaryFile({
      res,
      fullPath: projectilePath,
      downloadName: filename,
    });
  });

  router.get('/api/character_assets/:token/:character/:asset', async (req, res) => {
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

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('characters', character, `${asset}.png`), `${character}_${asset}.png`, { protectedResponse: true })) {
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

  router.get('/api/character_preview_asset/:character/:assetName', async (req, res) => {
    const character = String(req.params.character ?? '').trim().toLowerCase();
    const assetName = String(req.params.assetName ?? '').trim().toLowerCase();
    const assetPath = path.join(deps.staticDir, 'assets', 'characters', character, `${assetName}.png`);

    if (!fs.existsSync(assetPath)) {
      res.status(404).send('<h1>Not Found</h1>');
      return;
    }

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('characters', character, `${assetName}.png`), `${character}_${assetName}.png`, { protectedResponse: true })) {
      return;
    }

    sendProtectedBinaryFile({
      res,
      fullPath: assetPath,
      downloadName: `${character}_${assetName}.png`,
    });
  });

  router.get('/api/enemies', (_req, res) => {
    res.json(Object.values(listEnemyCatalog()));
  });

  router.get('/api/enemy_metadata/:enemyType', (req, res) => {
    const enemyType = String(req.params.enemyType ?? '').trim().toLowerCase();
    const metadata = loadEnemyMetadata({ staticDir: deps.staticDir, enemyType });

    if (!metadata) {
      res.status(404).send(`Enemy ${enemyType} not found`);
      return;
    }

    res.json(metadata);
  });

  router.post('/api/save_enemy_metadata', (req, res) => {
    const enemyType = String(req.body?.type ?? req.body?.enemyType ?? '').trim().toLowerCase();
    if (!enemyType) {
      res.status(400).json({ error: 'Enemy type is required' });
      return;
    }

    const currentMetadata = loadEnemyMetadata({ staticDir: deps.staticDir, enemyType });
    if (!currentMetadata) {
      res.status(404).json({ error: `Enemy ${enemyType} not found` });
      return;
    }

    const scale = Number(req.body?.scale);
    if (!Number.isFinite(scale) || scale <= 0) {
      res.status(400).json({ error: 'Enemy scale must be a positive number' });
      return;
    }

    const savedMetadata = saveEnemyMetadata({
      staticDir: deps.staticDir,
      enemyType,
      metadata: {
        ...currentMetadata,
        scale,
      },
    });

    res.json({
      success: true,
      metadata: savedMetadata,
    });
  });

  router.get('/api/enemy_asset/:token/:enemyType/:assetName', async (req, res) => {
    const assetSession = verifyAssetSession({ secretKey: deps.secretKey, req });
    if (!assetSession.ok) {
      res.status(assetSession.status).send('<h1>Access Denied</h1>');
      return;
    }

    const token = String(req.params.token ?? '');
    const enemyType = String(req.params.enemyType ?? '').trim().toLowerCase();
    const assetName = String(req.params.assetName ?? '').trim().toLowerCase();
    const verified = verifyToken({ secretKey: deps.secretKey, token });
    if (!verified.ok) {
      res.status(403).send('<h1>Access Denied</h1>');
      return;
    }

    const payload = verified.payload;
    if (
      payload.type !== 'enemy' ||
      payload.enemyType !== enemyType ||
      !tokenMatchesAssetSession({ payload, assetSessionId: assetSession.sessionId })
    ) {
      res.status(403).send('<h1>Access Denied</h1>');
      return;
    }

    const assetPath = path.join(deps.staticDir, 'assets', 'enemies', enemyType, `${assetName}.png`);

    if (!fs.existsSync(assetPath)) {
      res.status(404).send('<h1>Not Found</h1>');
      return;
    }

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('enemies', enemyType, `${assetName}.png`), `${enemyType}_${assetName}.png`, { protectedResponse: true })) {
      return;
    }

    sendProtectedBinaryFile({
      res,
      fullPath: assetPath,
      downloadName: `${enemyType}_${assetName}.png`,
    });
  });

  router.get('/api/character_card/:token/:character', async (req, res) => {
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

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('cards', `${selection.cardAsset}.png`), 'character-card.png', { protectedResponse: true })) {
      return;
    }

    sendProtectedBinaryFile({
      res,
      fullPath: assetPath,
      downloadName: 'character-card.png',
    });
  });

  router.get('/api/character_card_preview/:character', async (req, res) => {
    const character = String(req.params.character ?? '').trim().toLowerCase();
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

    if (await sendExternalBinaryFile(res, deps.assetCdnBaseUrl, path.join('cards', `${selection.cardAsset}.png`), `${selection.cardAsset}.png`, { protectedResponse: true })) {
      return;
    }

    setPublicAssetCacheHeaders(res);
    res.type('.png');
    res.sendFile(assetPath);
  });

  return router;
}

module.exports = { createAssetsRouter };
