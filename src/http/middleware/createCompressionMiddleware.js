function createCompressionMiddleware() {
  return function compressionMiddleware(req, res, next) {
    next();
  };
}

module.exports = { createCompressionMiddleware };
