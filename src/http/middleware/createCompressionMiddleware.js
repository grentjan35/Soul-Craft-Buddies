const zlib = require('zlib');

const DEFAULT_MIN_SIZE_BYTES = 1024;
const COMPRESSIBLE_TYPE_PATTERN = /^(text\/|application\/(json|javascript|xml)|image\/svg\+xml)/i;

function shouldCompressResponse(req, res, statusCode, contentType, contentLength) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return false;
  }

  if (statusCode < 200 || statusCode >= 300) {
    return false;
  }

  if (res.getHeader('Content-Encoding') || res.getHeader('Content-Range')) {
    return false;
  }

  if (typeof contentType !== 'string' || !COMPRESSIBLE_TYPE_PATTERN.test(contentType)) {
    return false;
  }

  if (Number.isFinite(contentLength) && contentLength > 0 && contentLength < DEFAULT_MIN_SIZE_BYTES) {
    return false;
  }

  const cacheControl = String(res.getHeader('Cache-Control') || '').toLowerCase();
  if (cacheControl.includes('no-transform')) {
    return false;
  }

  return true;
}

function pickEncoding(req) {
  const accepted = String(req.headers['accept-encoding'] || '').toLowerCase();
  if (accepted.includes('br')) {
    return 'br';
  }
  if (accepted.includes('gzip')) {
    return 'gzip';
  }
  return null;
}

function createCompressionStream(encoding) {
  if (encoding === 'br') {
    return zlib.createBrotliCompress({
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 4,
      },
    });
  }

  return zlib.createGzip({ level: 6 });
}

function createCompressionMiddleware() {
  return function compressionMiddleware(req, res, next) {
    const encoding = pickEncoding(req);
    if (!encoding) {
      next();
      return;
    }

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const originalOn = res.on.bind(res);
    let compressionStream = null;
    let compressionEnabled = false;

    function ensureCompression() {
      if (compressionEnabled) {
        return true;
      }

      const statusCode = res.statusCode;
      const contentType = String(res.getHeader('Content-Type') || '');
      const headerLength = Number(res.getHeader('Content-Length'));
      const contentLength = Number.isFinite(headerLength) ? headerLength : undefined;
      if (!shouldCompressResponse(req, res, statusCode, contentType, contentLength)) {
        return false;
      }

      compressionStream = createCompressionStream(encoding);
      compressionEnabled = true;

      res.removeHeader('Content-Length');
      res.setHeader('Content-Encoding', encoding);
      res.setHeader('Vary', 'Accept-Encoding');

      compressionStream.on('data', (chunk) => originalWrite(chunk));
      compressionStream.on('end', () => originalEnd());
      compressionStream.on('error', () => {
        if (!res.headersSent) {
          res.statusCode = 500;
        }
        originalEnd();
      });

      return true;
    }

    res.write = function write(chunk, ...args) {
      if (!chunk) {
        return originalWrite(chunk, ...args);
      }

      if (!ensureCompression()) {
        return originalWrite(chunk, ...args);
      }

      return compressionStream.write(chunk, ...args);
    };

    res.end = function end(chunk, ...args) {
      if (chunk && !ensureCompression()) {
        return originalEnd(chunk, ...args);
      }

      if (!compressionEnabled) {
        return originalEnd(chunk, ...args);
      }

      if (chunk) {
        compressionStream.end(chunk, ...args);
        return res;
      }

      compressionStream.end();
      return res;
    };

    res.on = function on(event, listener) {
      if (event === 'drain' && compressionEnabled) {
        return compressionStream.on(event, listener);
      }
      return originalOn(event, listener);
    };

    next();
  };
}

module.exports = { createCompressionMiddleware };
