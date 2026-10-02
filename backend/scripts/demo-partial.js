'use strict';

/**
 * Demo: run the aggregator with one failing source against the real
 * gateway logger so logs/gateway.log captures the partial marker.
 *
 *   node scripts/demo-partial.js
 */
const { createDashboardAggregator } = require('../src/services/dashboardAggregator');
const { createGatewayLogger } = require('../src/utils/gatewayLogger');

const sources = [{ name: 'counter' }, { name: 'localstack' }, { name: 'tasks' }];

const fetcher = async (source) => {
  if (source.name === 'localstack') {
    throw new Error('connect ECONNREFUSED (demo outage)');
  }
  return { items: [`${source.name}-1`, `${source.name}-2`], nextCursor: null };
};

async function main() {
  const agg = createDashboardAggregator({
    sources,
    fetcher,
    logger: createGatewayLogger(),
  });
  const result = await agg.getDashboard({ range: '7d' });
  process.stdout.write(
    `demo result: status=${result.status} missing=${result.missingSources.join(',')}\n`
  );
}

main();
