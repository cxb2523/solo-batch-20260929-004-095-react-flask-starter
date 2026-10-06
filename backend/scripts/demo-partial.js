'use strict';

/**
 * Drives the aggregator with one failing source through the real gateway
 * logger, so logs/gateway.log captures the `status=partial` marker.
 *
 *   node scripts/demo-partial.js
 *   npm run demo:partial
 */
const { createDashboardAggregator } = require('../src/services/dashboardAggregator');
const { createGatewayLogger } = require('../src/utils/gatewayLogger');

const sources = [{ name: 'counter' }, { name: 'localstack' }, { name: 'tasks' }];

const fetcher = async (source) => {
  if (source.name === 'localstack') {
    throw new Error('connect ECONNREFUSED (simulated outage)');
  }
  return { items: [`${source.name}-1`, `${source.name}-2`], nextCursor: null };
};

async function main() {
  const aggregator = createDashboardAggregator({
    sources,
    fetcher,
    logger: createGatewayLogger(),
  });

  const result = await aggregator.getDashboard({ range: '7d' });
  process.stdout.write(
    `demo result: status=${result.status} missing=${result.missingSources.join(',')} ` +
      `rendered=${Object.keys(result.cards).length}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${String(error && error.stack ? error.stack : error)}\n`);
  process.exitCode = 1;
});
