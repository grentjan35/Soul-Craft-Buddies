const express = require('express');
const fs = require('fs');
const path = require('path');

const { createBackup, listBackups, restoreBackup, getBackupDir } = require('./backupService');
const { loadEnemyCatalog, normalizeEnemySpawns } = require('../../enemies/catalog');

/**
 * Creates map + backup management endpoints.
 * @param {{dataDir: string, staticDir: string}} deps
 * @returns {import('express').Router}
 */
function createMapsRouter(deps) {
  const router = express.Router();
  const enemyCatalog = loadEnemyCatalog({ staticDir: deps.staticDir });

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
      if (type !== 'fire_small') {
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
    const maps = fs
      .readdirSync(deps.dataDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5));
    res.json(maps);
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
