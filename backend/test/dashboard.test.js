'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createDashboardAggregator } = require('../src/services/dashboardAggregator');
const { createAuthMiddleware } = require('../src/middleware/auth');
const { registerDashboardRoutes } = require('../src/routes/dashboard');
const { createGatewayLogger } = require('../src/utils/gatewayLogger');
const createDashboardClient = require('../src/static/js/dashboardClient');

const SOURCES = [{ name: 'counter' }, { name: 'localstack' }, { name: 'tasks' }];

function silentLogger(log = []) {
  return {
    logRequest(entry) {
      log.push(entry);
    },
  };
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    end(body) {
      this.body = body;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}
test('rule 1: all sources aggregate on one snapshot and cursor pages have no duplicates or gaps', async () => {
  const seenSnapshots = new Set();
  const fetcher = async (source, params) => {
    seenSnapshots.add(params.snapshot);
    if (source.name !== 'counter') {
      return { items: [`${source.name}-1`], nextCursor: null };
    }
    const pages = {
      first: { items: ['c1', 'c2'], nextCursor: 'p2' },
      p2: { items: ['c3', 'c4'], nextCursor: 'p3' },
      p3: { items: ['c5', 'c6'], nextCursor: null },
    };
    return pages[params.cursor || 'first'];
  };

  const aggregator = createDashboardAggregator({
    sources: SOURCES,
    fetcher,
    logger: silentLogger(),
  });
  const result = await aggregator.getDashboard({ range: '7d' });

  assert.equal(result.status, 'ok');
  assert.equal(seenSnapshots.size, 1, 'every source and page must share one snapshot');
  assert.deepEqual(result.cards.counter.items, ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
  assert.equal(result.total, 8);
});

test('rule 1: an upstream cursor loop is stopped without duplicating items', async () => {
  const fetcher = async (source, params) => {
    if (source.name !== 'counter') return { items: [], nextCursor: null };
    if (params.cursor === 'a') return { items: ['x2'], nextCursor: 'b' };
    if (params.cursor === 'b') return { items: ['x3'], nextCursor: 'a' };
    return { items: ['x1'], nextCursor: 'a' };
  };
  const aggregator = createDashboardAggregator({
    sources: SOURCES,
    fetcher,
    logger: silentLogger(),
  });
  const result = await aggregator.getDashboard({});
  assert.deepEqual(result.cards.counter.items, ['x1', 'x2', 'x3']);
});

test('rule 2: identical concurrent params run once per source and reuse one result within the TTL', async () => {
  let calls = 0;
  let tick = 1000;
  const fetcher = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { items: ['i'], nextCursor: null };
  };
  const aggregator = createDashboardAggregator({
    sources: SOURCES,
    fetcher,
    logger: silentLogger(),
    ttlMs: 500,
    now: () => tick,
  });

  const [a, b, c] = await Promise.all([
    aggregator.getDashboard({ range: '7d' }),
    aggregator.getDashboard({ range: '7d' }),
    aggregator.getDashboard({ range: '7d' }),
  ]);
  assert.equal(calls, 3, 'one fetch per source, not one per concurrent request');
  assert.equal(a.snapshotId, b.snapshotId);
  assert.equal(b.snapshotId, c.snapshotId);

  tick += 100; // still within TTL
  const d = await aggregator.getDashboard({ range: '7d' });
  assert.equal(calls, 3, 'a TTL hit must not refetch');
  assert.equal(d.snapshotId, a.snapshotId);

  tick += 1000; // TTL expired
  await aggregator.getDashboard({ range: '7d' });
  assert.equal(calls, 6, 'after TTL expiry a fresh run happens');
});

test('rule 3: a timed-out or errored source yields partial status with the missing source list and other cards intact', async () => {
  const log = [];
  const fetcher = async (source) => {
    if (source.name === 'localstack') {
      await new Promise((resolve) => setTimeout(resolve, 5000)); // times out
      return { items: ['late'] };
    }
    if (source.name === 'tasks') {
      throw new Error('boom');
    }
    return { items: ['c1'], nextCursor: null };
  };
  const aggregator = createDashboardAggregator({
    sources: SOURCES,
    fetcher,
    logger: silentLogger(log),
    timeoutMs: 50,
  });

  const result = await aggregator.getDashboard({});
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.missingSources.slice().sort(), ['localstack', 'tasks']);
  assert.equal(result.cards.counter.count, 1, 'healthy sources still render cards');
  assert.equal(result.cards.localstack.count, 0);
  assert.ok(
    log.some((entry) => entry.status === 'partial' && entry.route === '/api/dashboard'),
    'gateway log entry must carry the partial marker'
  );
});

test('rule 3: gateway logger appends a greppable status=partial line to its log file', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gw-log-')), 'gateway.log');
  const lines = [];
  const logger = createGatewayLogger({
    file,
    stdout: { write: (line) => lines.push(line) },
  });

  logger.logRequest({
    route: '/api/dashboard',
    status: 'partial',
    snapshotId: 'snap-test',
    cache: 'miss',
    missingSources: ['localstack'],
  });

  const written = fs.readFileSync(file, 'utf8').trim();
  assert.match(written, /\[gateway\] route=\/api\/dashboard status=partial/);
  assert.match(written, /missing=localstack/);
  assert.match(lines.join(''), /status=partial/);
});

test('rule 4: empty collections and share calculations are divide-by-zero safe', async () => {
  const fetcher = async () => ({ items: [], nextCursor: null });
  const aggregator = createDashboardAggregator({
    sources: SOURCES,
    fetcher,
    logger: silentLogger(),
  });
  const result = await aggregator.getDashboard({});
  assert.equal(result.total, 0);
  for (const name of ['counter', 'localstack', 'tasks']) {
    assert.equal(result.cards[name].count, 0);
    assert.equal(result.cards[name].share, 0);
  }
  assert.equal(aggregator.shareOf(3, 0), 0);
  assert.equal(aggregator.shareOf(Number.NaN, 10), 0);
  assert.equal(aggregator.shareOf(1, Number.POSITIVE_INFINITY), 0);
});

test('auth: missing or invalid Bearer token is rejected with 401 and never calls next', () => {
  const auth = createAuthMiddleware({
    verifyToken: (token) => (token === 'good' ? { user: 1 } : null),
  });

  const resNoToken = mockRes();
  let nextCalled = false;
  auth({ headers: {} }, resNoToken, () => {
    nextCalled = true;
  });
  assert.equal(resNoToken.statusCode, 401);
  assert.equal(nextCalled, false);
  assert.deepEqual(resNoToken.json(), { error: 'unauthorized' });

  const resBad = mockRes();
  auth({ headers: { authorization: 'Bearer bad' } }, resBad, () => {
    nextCalled = true;
  });
  assert.equal(resBad.statusCode, 401);
  assert.equal(nextCalled, false);

  const resGood = mockRes();
  let passed = false;
  const req = { headers: { authorization: 'Bearer good' } };
  auth(req, resGood, () => {
    passed = true;
  });
  assert.equal(passed, true);
  assert.equal(req.session.user, 1);
});

test('route: dashboard is mounted with auth first; a request without a token stops at 401 before the handler', () => {
  const routes = [];
  const app = {
    get(routePath, ...handlers) {
      routes.push({ routePath, handlers });
    },
  };
  const aggregator = createDashboardAggregator({
    sources: SOURCES,
    fetcher: async () => ({ items: [], nextCursor: null }),
    logger: silentLogger(),
  });
  registerDashboardRoutes(app, {
    aggregator,
    authMiddleware: createAuthMiddleware({ verifyToken: () => null }),
  });

  assert.equal(routes.length, 1);
  assert.equal(routes[0].routePath, '/api/dashboard');

  const [auth, handler] = routes[0].handlers;
  const res = mockRes();
  let handlerReached = false;
  auth({ headers: {}, query: {} }, res, () => {
    handlerReached = true;
  });
  assert.equal(res.statusCode, 401);
  assert.equal(handlerReached, false, '401 must short-circuit before aggregation runs');
  assert.equal(typeof handler, 'function');
});

test('route: an authenticated request returns the aggregated payload as JSON', async () => {
  const routes = [];
  const app = {
    get(routePath, ...handlers) {
      routes.push({ routePath, handlers });
    },
  };
  const aggregator = createDashboardAggregator({
    sources: SOURCES,
    fetcher: async (source) => ({ items: [`${source.name}-x`], nextCursor: null }),
    logger: silentLogger(),
  });
  registerDashboardRoutes(app, {
    aggregator,
    authMiddleware: createAuthMiddleware({ verifyToken: (token) => (token ? { token } : null) }),
  });

  const [auth, handler] = routes[0].handlers;
  const res = mockRes();
  await new Promise((resolve) => {
    const req = { headers: { authorization: 'Bearer good' }, query: { range: '7d' } };
    auth(req, res, () => {
      handler(req, res);
      setTimeout(resolve, 30);
    });
  });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.total, 3);
});

test('client: a 401 response clears the stored token immediately and redirects to /login', async () => {
  const removed = [];
  const redirects = [];
  const client = createDashboardClient({
    fetchImpl: async () => ({ status: 401, ok: false, json: async () => ({}) }),
    storage: {
      getItem: () => 'stale-token',
      removeItem: (key) => removed.push(key),
    },
    location: { replace: (url) => redirects.push(url) },
  });

  await assert.rejects(() => client.getDashboard(), /unauthorized/);
  assert.deepEqual(removed, ['dashboard_token']);
  assert.deepEqual(redirects, ['/login']);
});

test('client: offline refresh degrades to a partial payload naming every source, without throwing', async () => {
  const client = createDashboardClient({
    fetchImpl: async () => {
      throw new TypeError('fetch failed');
    },
    storage: { getItem: () => 'token', removeItem: () => {} },
    location: { replace: () => {} },
    knownSources: ['counter', 'localstack', 'tasks'],
  });

  const data = await client.getDashboard();
  assert.equal(data.status, 'partial');
  assert.equal(data.offline, true);
  assert.deepEqual(data.missingSources, ['counter', 'localstack', 'tasks']);
});
