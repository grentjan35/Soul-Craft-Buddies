const fs = require('fs');

/**
 * Loads manifest.json from disk.
 * @param {{manifestPath: string}} deps
 * @returns {{ok: true, manifest: Record<string, {chunk_ids: string[], total_size: number}>} | {ok: false, reason: string}}
 */
function loadManifest(deps) {
  try {
    const raw = fs.readFileSync(deps.manifestPath, 'utf8');
    /** @type {Record<string, {chunk_ids: string[], total_size: number}>} */
    const manifest = JSON.parse(raw);
    if (!manifest || typeof manifest !== 'object') {
      return { ok: false, reason: 'Manifest invalid' };
    }
    return { ok: true, manifest };
  } catch (err) {
    return { ok: false, reason: 'Manifest missing or unreadable' };
  }
}

module.exports = { loadManifest };
