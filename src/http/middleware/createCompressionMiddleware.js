const zlib = require('zlib');

const MIN_COMPRESSIBLE_BYTES = 1024;

function appendVaryHeader(res, value) {
  const current = res.getHeader('Vary');
  if (!current) {
    res.setHeader('Vary', value);
    return;
  }

  const normalized = String(current);
  if (!normalized.toLowerCase().includes(value.toLowerCase())) {
    res.setHeader('Vary', `${normalized}, ${value}`);
  }
}

function isCompressibleContentType(contentType) {
  const value = String(contentType || '').toLowerCase();
  return (
    value.startsWith('text/') ||
    value.includes('application/json') ||
    value.includes('application/javascript') ||
    value.includes('application/x-javascript') ||
    value.includes('application/xml') ||
    value.includes('image/svg+xml')
  );
}

function canCompressResponse(req, res, firstChunk) {
  if (req.method === 'HEAD') {
    return false;
  }

  if (res.statusCode < 200 || res.statusCode === 204 || res.statusCode === 304) {
    return false;
  }

  if (res.getHeader('Content-Encoding') || res.getHeader('Content-Range')) {
    return false;
  }

  const contentType = res.getHeader('Content-Type');
  if (!isCompressibleContentType(contentType)) {
    return false;
  }

  const contentLengthHeader = res.getHeader('Content-Length');
  const contentLength = Number(contentLengthHeader);
  if (Number.isFinite(contentLength) && contentLength > 0 && contentLength < MIN_COMPRESSIBLE_BYTES) {
    return false;
  }

  if (
    !Number.isFinite(contentLength) &&
    firstChunk &&
    Buffer.byteLength(firstChunk) < MIN_COMPRESSIBLE_BYTES
  ) {
    return false;
  }

  const cacheControl = String(res.getHeader('Cache-Control') || '').toLowerCase();
  if (cacheControl.includes('no-transform')) {
    return false;
  }

  return true;
}

function pickEncoding(req) {
  const acceptEncoding = String(req.headers['accept-encoding'] || '').toLowerCase();
  if (acceptEncoding.includes('br')) {
    return 'br';
  }
  if (acceptEncoding.includes('gzip')) {
    return 'gzip';
  }
  return null;
}

function createCompressionStream(encoding) {
  if (encoding === 'br') {
    return zlib.createBrotliCompress({
      params: {
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
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
    let stream = null;
    let compressionInitialized = false;
    let compressResponse = false;

    function initializeCompression(firstChunk) {
      if (compressionInitialized) {
        return;
      }

      compressionInitialized = true;
      compressResponse = canCompressResponse(req, res, firstChunk);
      appendVaryHeader(res, 'Accept-Encoding');

      if (!compressResponse) {
        return;
      }

      stream = createCompressionStream(encoding);
      res.setHeader('Content-Encoding', encoding);
      res.removeHeader('Content-Length');

      stream.on('data', (chunk) => {
        originalWrite(chunk);
      });

      stream.on('end', () => {
        originalEnd();
      });

      stream.on('error', () => {
        if (!res.headersSent) {
          res.statusCode = 500;
          originalEnd('Compression error');
          return;
        }
        res.destroy();
      });
    }

    res.write = function write(chunk, chunkEncoding, callback) {
      initializeCompression(chunk);
      if (!compressResponse || !stream) {
        return originalWrite(chunk, chunkEncoding, callback);
      }
      return stream.write(chunk, chunkEncoding, callback);
    };

    res.end = function end(chunk, chunkEncoding, callback) {
      initializeCompression(chunk);
      if (!compressResponse || !stream) {
        return originalEnd(chunk, chunkEncoding, callback);
      }

      if (chunk) {
        return stream.end(chunk, chunkEncoding, callback);
      }

      return stream.end(callback);
    };

    next();
  };
}

module.exports = { createCompressionMiddleware };
