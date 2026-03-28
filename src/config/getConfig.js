const path = require('path');

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
 *   chunkDir: string,
 *   manifestPath: string
 * }}
 */
function getConfig() {
  const projectRoot = path.resolve(__dirname, '..', '..');

  const portRaw = process.env.PORT ?? '5000';
  const port = Number.parseInt(portRaw, 10);
  if (!Number.isFinite(port)) {
    throw new Error(`Invalid PORT: ${portRaw}`);
  }

  const bindHost = process.env.HOST ?? '0.0.0.0';
  const secretKey =
    process.env.SECRET_KEY ?? 'platformer_buddies_secure_key_v2_2026!';

  return {
    port,
    bindHost,
    secretKey,
    projectRoot,
    staticDir: path.join(projectRoot, 'static'),
    templatesDir: path.join(projectRoot, 'templates'),
    dataDir: path.join(projectRoot, 'data'),
    chunkDir: path.join(projectRoot, 'secure_asset_chunks'),
    manifestPath: path.join(projectRoot, 'manifest.json'),
  };
}

module.exports = { getConfig };
