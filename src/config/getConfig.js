const path = require('path');
const fs = require('fs');

require('dotenv').config();

/**
 * Loads runtime configuration from environment.
 * @returns {{
 *   port: number,
 *   bindHost: string,
 *   secretKey: string,
 *   projectRoot: string,
 *   staticDir: string,
 *   templatesDir: string,
 *   dataDir: string,
 *   manifestPath: string
 * }}
 */
function getConfig() {
  const projectRoot = path.resolve(__dirname, '..', '..');
  const defaultDataDir = path.join(projectRoot, 'data');
  const dataDir = path.resolve(process.env.DATA_DIR ?? defaultDataDir);
  const templatesDir = path.resolve(process.env.TEMPLATES_DIR ?? path.join(projectRoot, 'templates'));
  const staticDir = path.resolve(process.env.STATIC_DIR ?? path.join(projectRoot, 'static'));
  const manifestPath = path.resolve(process.env.MANIFEST_PATH ?? path.join(projectRoot, 'manifest.json'));

  const portRaw = process.env.PORT ?? '5000';
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port)) {
    throw new Error(`Invalid PORT: ${portRaw}`);
  }

  const bindHost = process.env.HOST ?? '0.0.0.0';
  const secretKey =
    process.env.SECRET_KEY ?? 'platformer_buddies_secure_key_v2_2026!';

  fs.mkdirSync(dataDir, { recursive: true });

  return {
    port,
    bindHost,
    secretKey,
    projectRoot,
    staticDir,
    templatesDir,
    dataDir,
    manifestPath,
  };
}

module.exports = { getConfig };
