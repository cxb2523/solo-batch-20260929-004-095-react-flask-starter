'use strict';

const { createAuthMiddleware } = require('../middleware/auth');

/**
 * Dashboard route: mounting and auth only. All data fetching and
 * aggregation lives in ../services/dashboardAggregator.
 *
 * Usage:
 *   const { createDashboardAggregator } = require('../services/dashboardAggregator');
 *   const aggregator = createDashboardAggregator({ sources, fetcher, logger });
 *   registerDashboardRoutes(app, { aggregator });
 *
 * `app` is anything express-like exposing .get(path, ...handlers).
 */
function registerDashboardRoutes(app, { aggregator, authMiddleware }) {
  if (!aggregator || typeof aggregator.getDashboard !== 'function') {
    throw new Error('registerDashboardRoutes requires an aggregator');
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
      (err) => {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'aggregation_failed', detail: String(err) }));
      }
    );
  });
}

module.exports = { registerDashboardRoutes };
