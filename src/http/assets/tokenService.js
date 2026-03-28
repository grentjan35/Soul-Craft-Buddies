const jwt = require('jsonwebtoken');

/**
 * Signs a short-lived token.
 * Why: Replace itsdangerous with HMAC-signed JWT tokens.
 * @param {{secretKey: string, payload: object, expiresInSeconds: number}} input
 * @returns {string}
 */
function signToken(input) {
  return jwt.sign(input.payload, input.secretKey, {
    algorithm: 'HS256',
    expiresIn: input.expiresInSeconds,
  });
}

/**
 * Verifies a token and returns its payload.
 * @param {{secretKey: string, token: string}} input
 * @returns {{ok: true, payload: object} | {ok: false, reason: string}}
 */
function verifyToken(input) {
  try {
    const payload = jwt.verify(input.token, input.secretKey, {
      algorithms: ['HS256'],
    });
    if (payload && typeof payload === 'object') {
      return { ok: true, payload };
    }
    return { ok: false, reason: 'Invalid token payload' };
  } catch (err) {
    if (err && typeof err === 'object' && err.name === 'TokenExpiredError') {
      return { ok: false, reason: 'Token expired' };
    }
    return { ok: false, reason: 'Invalid token' };
  }
}

module.exports = { signToken, verifyToken };
