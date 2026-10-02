'use strict';

/**
 * Auth middleware. Verifies the Bearer token on the request and either
 * calls next() (authenticated) or terminates with 401. The dashboard
 * router mounts this in front of every aggregation route.
 *
 * Options:
 *   verifyToken(token) -> truthy session object or falsy. Injectable for tests.
 */
function createAuthMiddleware({ verifyToken } = {}) {
  const verify =
    verifyToken ||
    ((token) => {
      // Default policy: any non-empty, non-expired-looking token passes.
      // Real deployments inject verifyToken backed by the session store.
      return token && token.length > 0 ? { token } : null;
    });

  return function authMiddleware(req, res, next) {
    const header = req.headers && req.headers.authorization;
    const token =
      header && header.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : null;
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
