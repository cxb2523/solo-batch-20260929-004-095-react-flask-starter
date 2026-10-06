'use strict';

/**
 * Auth middleware for the dashboard gateway.
 *
 * Extracts and verifies the Bearer token. On success it attaches the
 * session to the request and calls next(); on failure it terminates the
 * request with 401 so no handler (and therefore no half-authenticated
 * state) is ever reached.
 *
 * Options:
 *   verifyToken(token) -> session object (truthy) or null/falsy.
 *                         Injectable so tests can drive the 401 branch.
 */
function createAuthMiddleware({ verifyToken } = {}) {
  const verify =
    verifyToken ||
    ((token) => (token && token.length > 0 ? { token } : null));

  const BEARER = 'Bearer ';

  return function authMiddleware(req, res, next) {
    const header = (req.headers && req.headers.authorization) || '';
    const token = header.startsWith(BEARER) ? header.slice(BEARER.length).trim() : '';
    const session = token ? verify(token) : null;

    if (!session) {
      res.statusCode = 401;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    req.session = session;
    next();
  };
}

module.exports = { createAuthMiddleware };
