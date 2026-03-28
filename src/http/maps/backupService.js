const fs = require('fs');
const path = require('path');

const MAX_BACKUPS_PER_MAP = 10;

/**
 * Returns the backup directory for a map.
 * @param {{dataDir: string, mapName: string}} input
 * @returns {string}
 */
function getBackupDir(input) {
  return path.join(input.dataDir, 'backups', input.mapName);
}

/**
 * Keeps only the newest MAX_BACKUPS_PER_MAP backups.
 * @param {{backupDir: string}} input
 * @returns {void}
 */
function cleanOldBackups(input) {
  if (!fs.existsSync(input.backupDir)) {
    return;
  }

  const files = fs
    .readdirSync(input.backupDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const p = path.join(input.backupDir, f);
      return { path: p, mtimeMs: fs.statSync(p).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (files.length <= MAX_BACKUPS_PER_MAP) {
    return;
  }

  const toDelete = files.slice(MAX_BACKUPS_PER_MAP);
  for (const item of toDelete) {
    fs.unlinkSync(item.path);
  }
}

/**
 * Creates a timestamped backup of an existing map.
 * @param {{dataDir: string, mapName: string}} input
 * @returns {{ok: true, backupPath: string} | {ok: false, reason: string}}
 */
function createBackup(input) {
  const mapPath = path.join(input.dataDir, `${input.mapName}.json`);
  if (!fs.existsSync(mapPath)) {
    return { ok: false, reason: 'Map not found' };
  }

  const backupDir = getBackupDir(input);
  fs.mkdirSync(backupDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(backupDir, `${timestamp}_${input.mapName}.json`);

  const raw = fs.readFileSync(mapPath, 'utf8');
  fs.writeFileSync(backupPath, raw);

  cleanOldBackups({ backupDir });
  return { ok: true, backupPath };
}

/**
 * Lists backups for a map.
 * @param {{dataDir: string, mapName: string}} input
 * @returns {Array<{filename: string, timestamp: string, path: string}>}
 */
function listBackups(input) {
  const backupDir = getBackupDir(input);
  if (!fs.existsSync(backupDir)) {
    return [];
  }

  const items = fs.readdirSync(backupDir).filter((f) => f.endsWith('.json'));
  const backups = items.map((filename) => {
    const fullPath = path.join(backupDir, filename);
    const mtimeMs = fs.statSync(fullPath).mtimeMs;
    const timestamp = new Date(mtimeMs).toISOString();
    return { filename, timestamp, path: fullPath };
  });

  return backups.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
}

/**
 * Restores a map from a backup filename.
 * @param {{dataDir: string, mapName: string, backupFilename: string}} input
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function restoreBackup(input) {
  const backupDir = getBackupDir({ dataDir: input.dataDir, mapName: input.mapName });
  const backupPath = path.join(backupDir, input.backupFilename);
  if (!fs.existsSync(backupPath)) {
    return { ok: false, reason: 'Backup not found' };
  }

  const mapPath = path.join(input.dataDir, `${input.mapName}.json`);
  fs.writeFileSync(mapPath, fs.readFileSync(backupPath, 'utf8'));
  return { ok: true };
}

module.exports = { getBackupDir, createBackup, listBackups, restoreBackup };
