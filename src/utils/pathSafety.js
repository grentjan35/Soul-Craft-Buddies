const path = require('path');

/**
 * Resolves a user-provided relative path under a base dir, preventing traversal.
 * Why: Mirrors Python's "ensure within base dir" safety.
 * @param {{baseDir: string, userPath: string}} input
 * @returns {{ok: true, fullPath: string} | {ok: false, reason: string}}
 */
function resolveUnderBaseDir(input) {
  const normalizedUserPath = input.userPath.replace(/^\/+/, '');
  const fullPath = path.normalize(path.join(input.baseDir, normalizedUserPath));

  const baseDirNormalized = path.normalize(input.baseDir + path.sep);
  if (!fullPath.startsWith(baseDirNormalized)) {
    return { ok: false, reason: 'Unauthorized path' };
  }

  return { ok: true, fullPath };
}

module.exports = { resolveUnderBaseDir };
