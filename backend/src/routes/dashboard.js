'use strict';

const { createAuthMiddleware } = require('../middleware/auth');

/**
 * Dashboard route: mounting + authentication only.
 *
 * Data fetching and aggregation live in
 * src/services/dashboardAggregator.js (the request-wrapper module).
 *
 *   const { createDashboardAggregator } = require('../services/dashboardAggregator');
 *   registerDashboardRoutes(app, { aggregator });
 *
 * `app` is anything express-like with app.get(path, ...handlers).
 */
function registerDashboardRoutes(app, { aggregator, authMiddleware } = {}) {
  if (!aggregator || typeof aggregator.getDashboard !== 'function') {
    throw new Error('registerDashboardRoutes: an aggregator with getDashboard is required');
  }
  const auth = authMiddleware || createAuthMiddleware();

  app.get('/api/dashboard', auth, (req, res) => {
    const params = (req && req.query) || {};

    aggregator.getDashboard(params).then(
      (result) => {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(result));
      },
      (error) => {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'aggregation_failed', detail: String(error) }));
      }
    );
  });
}

module.exports = { registerDashboardRoutes };
