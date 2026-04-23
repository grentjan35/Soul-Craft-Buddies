const express = require('express');
const fs = require('fs');
const path = require('path');

const { createBackup, listBackups, restoreBackup, getBackupDir } = require('./backupService');
const { loadEnemyCatalog, normalizeEnemySpawns } = require('../../enemies/catalog');
const VALID_DECOR_TYPES = new Set(['fire_small', 'fire_purple']);

/**
 * Creates map + backup management endpoints.
 * @param {{dataDir: string, staticDir: string}} deps
 * @returns {import('express').Router}
 */
function createMapsRouter(deps) {
  const router = express.Router();
  const enemyCatalog = loadEnemyCatalog({ staticDir: deps.staticDir });
  const mobileLayoutsPath = path.join(deps.dataDir, 'mobile-layout-presets.json');

  function loadMobileLayouts() {
    try {
      if (!fs.existsSync(mobileLayoutsPath)) {
        return { presets: [] };
      }

      const raw = fs.readFileSync(mobileLayoutsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.presets)) {
        return { presets: [] };
      }

      return { presets: parsed.presets };
    } catch {
      return { presets: [] };
    }
  }

  function saveMobileLayouts(payload) {
    fs.writeFileSync(mobileLayoutsPath, JSON.stringify(payload, null, 2));
  }

  function setRevalidationCacheHeaders(res) {
    res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate');
  }

  router.post('/api/save_map', (req, res) => {
    const name = String(req.body?.name ?? '').trim();
    const width = Number(req.body?.width ?? 25);
    const height = Number(req.body?.height ?? 18);
    const tiles = req.body?.tiles;
    const spawnPoints = req.body?.spawnPoints ?? [];
    const tileCollisions = req.body?.tileCollisions ?? {};
    const backgrounds = req.body?.backgrounds ?? [];
    const enemies = normalizeEnemySpawns(req.body?.enemies ?? [], enemyCatalog);
    const decor = Array.isArray(req.body?.decor) ? req.body.decor : [];

    if (!name) {
      res.status(400).json({ error: 'Map name is required' });
      return;
    }

    if (!(width >= 10 && width <= 200 && height >= 10 && height <= 200)) {
      res.status(400).json({ error: 'Map dimensions must be between 10 and 200' });
      return;
    }

    if (!Array.isArray(tiles) || tiles.length !== height) {
      res.status(400).json({ error: 'Tiles array does not match map dimensions' });
      return;
    }

    for (const row of tiles) {
      if (!Array.isArray(row) || row.length !== width) {
        res.status(400).json({ error: 'Tiles array does not match map dimensions' });
        return;
      }
      for (const tile of row) {
        if (tile !== -1 && !(Number.isInteger(tile) && tile >= 0 && tile < 12)) {
          res.status(400).json({ error: `Invalid tile index: ${tile}` });
          return;
        }
      }
    }

    for (const spawn of spawnPoints) {
      if (!spawn || typeof spawn !== 'object') {
        res.status(400).json({ error: 'Invalid spawn point format' });
        return;
      }
      if (typeof spawn.x !== 'number' || typeof spawn.y !== 'number') {
        res.status(400).json({ error: 'Spawn point must have x and y coordinates' });
        return;
      }
    }

    for (const background of backgrounds) {
      if (!background || typeof background !== 'object') {
        res.status(400).json({ error: 'Invalid background format' });
        return;
      }

      const asset = String(background.asset ?? '').trim();
      if (!/^background_\d+\.png$/i.test(asset)) {
        res.status(400).json({ error: `Invalid background asset: ${asset || '(missing)'}` });
        return;
      }

      if (!Number.isFinite(background.x) || !Number.isFinite(background.y)) {
        res.status(400).json({ error: 'Background must have numeric x and y coordinates' });
        return;
      }
    }

    for (const entry of decor) {
      if (!entry || typeof entry !== 'object') {
        res.status(400).json({ error: 'Invalid decor format' });
        return;
      }

      const type = String(entry.type ?? '').trim().toLowerCase();
      if (!VALID_DECOR_TYPES.has(type)) {
        res.status(400).json({ error: `Invalid decor type: ${type || '(missing)'}` });
        return;
      }

      if (!Number.isFinite(entry.x) || !Number.isFinite(entry.y)) {
        res.status(400).json({ error: 'Decor must have numeric x and y coordinates' });
        return;
      }
    }

    if (Array.isArray(req.body?.enemies) && enemies.length !== req.body.enemies.length) {
      res.status(400).json({ error: 'Enemy spawns must have valid ids, types, and coordinates' });
      return;
    }

    try {
      createBackup({ dataDir: deps.dataDir, mapName: path.basename(name) });
    } catch {
      // Backup is best-effort.
    }

    const mapPath = path.join(deps.dataDir, `${path.basename(name)}.json`);
    fs.writeFileSync(
      mapPath,
      JSON.stringify({
        name,
        width,
        height,
        tiles,
        spawnPoints,
        tileCollisions,
        backgrounds,
        enemies,
        decor,
      })
    );

    res.json({ success: true, message: `Map "${name}" saved successfully` });
  });

  router.get('/api/load_map/:mapName', (req, res) => {
    setRevalidationCacheHeaders(res);
    const mapName = path.basename(String(req.params.mapName ?? ''));
    const mapPath = path.join(deps.dataDir, `${mapName}.json`);

    if (!fs.existsSync(mapPath)) {
      res.status(404).json({ error: 'Map not found' });
      return;
    }

    try {
      const raw = fs.readFileSync(mapPath, 'utf8');
      const mapData = JSON.parse(raw);
      if (!mapData.tileCollisions) {
        mapData.tileCollisions = {};
      }
      if (!Array.isArray(mapData.backgrounds)) {
        mapData.backgrounds = [];
      }
      if (!Array.isArray(mapData.enemies)) {
        mapData.enemies = [];
      }
      if (!Array.isArray(mapData.decor)) {
        mapData.decor = [];
      }
      res.json(mapData);
    } catch {
      res.status(500).json({ error: 'Server error' });
    }
  });

  router.get('/api/list_maps', (_req, res) => {
    setRevalidationCacheHeaders(res);
    const maps = fs
      .readdirSync(deps.dataDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5));
    res.json(maps);
  });

  router.get('/api/mobile_layouts', (_req, res) => {
    setRevalidationCacheHeaders(res);
    res.json(loadMobileLayouts());
  });

  router.post('/api/mobile_layouts', (req, res) => {
    const preset = req.body?.preset;
    if (!preset || typeof preset !== 'object') {
      res.status(400).json({ error: 'Preset is required' });
      return;
    }

    const id = String(preset.id ?? '').trim();
    const name = String(preset.name ?? '').trim();
    const width = Number(preset.width);
    const height = Number(preset.height);

    if (!id || !name) {
      res.status(400).json({ error: 'Preset id and name are required' });
      return;
    }

    if (!Number.isFinite(width) || width < 200 || !Number.isFinite(height) || height < 200) {
      res.status(400).json({ error: 'Preset width and height must be valid numbers' });
      return;
    }

    const normalizedPreset = {
      id: path.basename(id),
      name,
      width: Math.round(width),
      height: Math.round(height),
      aspectRatio: Number.isFinite(Number(preset.aspectRatio))
        ? Number(Number(preset.aspectRatio).toFixed(4))
        : Number((width / height).toFixed(4)),
      layout: preset.layout && typeof preset.layout === 'object' ? preset.layout : {},
      updatedAt: new Date().toISOString(),
    };

    const payload = loadMobileLayouts();
    const existingIndex = payload.presets.findIndex((entry) => entry.id === normalizedPreset.id);
    if (existingIndex >= 0) {
      payload.presets[existingIndex] = normalizedPreset;
    } else {
      payload.presets.push(normalizedPreset);
    }

    payload.presets.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    saveMobileLayouts(payload);
    res.json({ success: true, preset: normalizedPreset });
  });

  router.delete('/api/delete_map/:mapName', (req, res) => {
    const mapName = path.basename(String(req.params.mapName ?? ''));
    const mapPath = path.join(deps.dataDir, `${mapName}.json`);

    if (!fs.existsSync(mapPath)) {
      res.status(404).json({ error: 'Map not found' });
      return;
    }

    fs.unlinkSync(mapPath);
    res.json({ success: true, message: `Map "${mapName}" deleted successfully` });
  });

  router.get('/api/backups/:mapName', (req, res) => {
    setRevalidationCacheHeaders(res);
    const mapName = path.basename(String(req.params.mapName ?? ''));
    res.json(listBackups({ dataDir: deps.dataDir, mapName }));
  });

  router.post('/api/restore_backup', (req, res) => {
    const mapName = path.basename(String(req.body?.map_name ?? '').trim());
    const backupFilename = path.basename(String(req.body?.backup_filename ?? '').trim());

    if (!mapName) {
      res.status(400).json({ error: 'Map name is required' });
      return;
    }
    if (!backupFilename) {
      res.status(400).json({ error: 'Backup filename is required' });
      return;
    }

    const result = restoreBackup({ dataDir: deps.dataDir, mapName, backupFilename });
    if (!result.ok) {
      res.status(404).json({ error: result.reason });
      return;
    }

    res.json({ success: true, message: `Map "${mapName}" restored successfully` });
  });

  router.delete('/api/backups/:mapName/:backupFilename', (req, res) => {
    const mapName = path.basename(String(req.params.mapName ?? ''));
    const backupFilename = path.basename(String(req.params.backupFilename ?? ''));

    const backupDir = getBackupDir({ dataDir: deps.dataDir, mapName });
    const backupPath = path.join(backupDir, backupFilename);

    if (!fs.existsSync(backupPath)) {
      res.status(404).json({ error: 'Backup not found' });
      return;
    }

    fs.unlinkSync(backupPath);
    res.json({ success: true, message: `Backup "${backupFilename}" deleted successfully` });
  });

  router.get('/api/current_map', (req, res) => {
    setRevalidationCacheHeaders(res);
    const mapName = path.basename(String(req.query?.map ?? 'default'));

    const mapPath = path.join(deps.dataDir, `${mapName}.json`);
    if (fs.existsSync(mapPath)) {
      const mapData = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
      if (!Array.isArray(mapData.enemies)) {
        mapData.enemies = [];
      }
      if (!Array.isArray(mapData.backgrounds)) {
        mapData.backgrounds = [];
      }
      if (!Array.isArray(mapData.decor)) {
        mapData.decor = [];
      }
      if (!mapData.tileCollisions) {
        mapData.tileCollisions = {};
      }
      res.json(mapData);
      return;
    }

    const defaultPath = path.join(deps.dataDir, 'default.json');
    if (fs.existsSync(defaultPath)) {
      const mapData = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
      if (!Array.isArray(mapData.enemies)) {
        mapData.enemies = [];
      }
      if (!Array.isArray(mapData.backgrounds)) {
        mapData.backgrounds = [];
      }
      if (!Array.isArray(mapData.decor)) {
        mapData.decor = [];
      }
      if (!mapData.tileCollisions) {
        mapData.tileCollisions = {};
      }
      res.json(mapData);
      return;
    }

    res.json({
      name: 'default',
      width: 25,
      height: 18,
      tiles: Array.from({ length: 18 }, () => Array.from({ length: 25 }, () => -1)),
      spawnPoints: [],
      backgrounds: [],
      enemies: [],
      decor: [],
    });
  });

  return router;
}

module.exports = { createMapsRouter };
