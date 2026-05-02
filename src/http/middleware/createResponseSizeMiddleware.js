const { formatBytes } = require('../../utils/formatBytes');

let totalBytesSent = 0;
let responseCount = 0;
let initialLoadLogged = false;
let lastRequestTime = Date.now();
let loadCheckTimer = null;
const LOAD_PAUSE_MS = 2000;
const MIN_REQUESTS_FOR_LOAD = 5;

/**
 * Logs the total and marks initial load as complete.
 */
function logInitialTotal() {
  if (!initialLoadLogged && responseCount >= MIN_REQUESTS_FOR_LOAD) {
    initialLoadLogged = true;
    console.log('='.repeat(60));
    console.log(`Initial load complete - Total: ${formatBytes(totalBytesSent)} total`);
    console.log('='.repeat(60));
  }
}

/**
 * Simplifies a path by removing JWT tokens and showing asset names.
 * @param {string} path
 * @returns {string}
 */
function simplifyPath(path) {
  if (!path) return path;

  const parts = path.split('/');

  // Replace any part that looks like a JWT token (long base64 string with dots)
  const simplified = parts.map(part => {
    if (part.length > 50 && part.includes('.')) {
      return '...';
    }
    return part;
  });

  return simplified.join('/');
}

/**
 * Creates middleware to track and log HTTP response sizes.
 * Logs individual response sizes and maintains a running total.
 * @returns {import('express').RequestHandler}
 */
function createResponseSizeMiddleware() {
  return function responseSizeMiddleware(req, res, next) {
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    let bytesWritten = 0;

    res.write = function write(chunk, ...args) {
      if (chunk) {
        bytesWritten += Buffer.byteLength(chunk);
      }
      return originalWrite(chunk, ...args);
    };

    res.end = function end(chunk, ...args) {
      if (chunk) {
        bytesWritten += Buffer.byteLength(chunk);
      }

      if (bytesWritten > 0) {
        totalBytesSent += bytesWritten;
        responseCount++;
        lastRequestTime = Date.now();

        const source = res.getHeader('X-Asset-Source') || '';
        const simplePath = simplifyPath(req.path);
        const sourcePrefix = source ? `${source} ` : '';
        console.log(`${req.method} ${sourcePrefix}${simplePath} ${formatBytes(bytesWritten)}`);

        // Reset the timer to check for load completion
        if (loadCheckTimer) {
          clearTimeout(loadCheckTimer);
        }
        loadCheckTimer = setTimeout(() => {
          logInitialTotal();
        }, LOAD_PAUSE_MS);
      }

      return originalEnd(chunk, ...args);
    };

    next();
  };
}

/**
 * Gets the total bytes sent across all HTTP responses.
 * @returns {{totalBytes: number, responseCount: number, formattedTotal: string}}
 */
function getTotalResponseStats() {
  return {
    totalBytes: totalBytesSent,
    responseCount: responseCount,
    formattedTotal: formatBytes(totalBytesSent),
  };
}

/**
 * Resets the response size tracking counters.
 */
function resetResponseStats() {
  totalBytesSent = 0;
  responseCount = 0;
  initialLoadLogged = false;
  lastRequestTime = Date.now();
  if (loadCheckTimer) {
    clearTimeout(loadCheckTimer);
    loadCheckTimer = null;
  }
}

module.exports = {
  createResponseSizeMiddleware,
  getTotalResponseStats,
  resetResponseStats,
};
