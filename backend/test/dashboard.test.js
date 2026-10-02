'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createDashboardAggregator } = require('../src/services/dashboardAggregator');
const { createAuthMiddleware } = require('../src/middleware/auth');
const { registerDashboardRoutes } = require('../src/routes/dashboard');
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
    setHeader(k, v) {
      this.headers[k] = v;
    },
    end(body) {
      this.body = body;
    },
    json() {
      return JSON.parse(this.body);
    },
  };
}

test('aggregates all sources on one snapshot; cursor pagination has no duplicates or gaps', async () => {
  const seenSnapshots = new Set();
  const fetcher = async (source, params) => {
    seenSnapshots.add(params.snapshot);
    if (source.name !== 'counter') {
      return { items: [`${source.name}-1`], nextCursor: null };
    }
    // Paginated source: 3 pages of 2 items each.
    const pages = {
      first: { items: ['c1', 'c2'], nextCursor: 'p2' },
      p2: { items: ['c3', 'c4'], nextCursor: 'p3' },
      p3: { items: ['c5', 'c6'], nextCursor: null },
    };
    return pages[params.cursor || 'first'];
  };

  const agg = createDashboardAggregator({ sources: SOURCES, fetcher, logger: silentLogger() });
  const result = await agg.getDashboard({ range: '7d' });

  assert.equal(result.status, 'ok');
  assert.equal(seenSnapshots.size, 1, 'every source/page must share one snapshot');
  assert.deepEqual(result.cards.counter.items, ['c1', 'c2', 'c3', 'c4', 'c5', 'c6']);
  assert.equal(result.total, 8);
});

test('cursor loop from upstream stops without duplicating items', async () => {
  const fetcher = async (source, params) => {
    if (source.name !== 'counter') return { items: [], nextCursor: null };
    // Pathological upstream: cursor alternates a -> b -> a -> ...
    return params.cursor === 'a'
      ? { items: ['x2'], nextCursor: 'b' }
      : params.cursor === 'b'
        ? { items: ['x3'], nextCursor: 'a' }
        : { items: ['x1'], nextCursor: 'a' };
  };
  const agg = createDashboardAggregator({ sources: SOURCES, fetcher, logger: silentLogger() });
  const result = await agg.getDashboard({});
  assert.deepEqual(result.cards.counter.items, ['x1', 'x2', 'x3']);
});

test('identical concurrent params run once and are reused within the TTL', async () => {
  let calls = 0;
  let tick = 1000;
  const fetcher = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 20));
    return { items: ['i'], nextCursor: null };
  };
  const agg = createDashboardAggregator({
    sources: SOURCES,
    fetcher,
    logger: silentLogger(),
    ttlMs: 500,
    now: () => tick,
  });

  const [a, b, c] = await Promise.all([
    agg.getDashboard({ range: '7d' }),
    agg.getDashboard({ range: '7d' }),
    agg.getDashboard({ range: '7d' }),
  ]);
  assert.equal(calls, 3, 'one fetch per source, not per request');
  assert.equal(a.snapshotId, b.snapshotId);
  assert.equal(b.snapshotId, c.snapshotId);

  tick += 100; // within TTL
  const d = await agg.getDashboard({ range: '7d' });
  assert.equal(calls, 3, 'TTL hit must not refetch');
  assert.equal(d.snapshotId, a.snapshotId);

  tick += 1000; // TTL expired
  await agg.getDashboard({ range: '7d' });
  assert.equal(calls, 6, 'after TTL a fresh fetch runs');
});

test('a timed-out or failing source degrades the response to partial with the missing source list', async () => {
  const log = [];
  const fetcher = async (source) => {
    if (source.name === 'localstack') {
      await new Promise((r) => setTimeout(r, 5000)); // will time out
      return { items: ['late'], nextCursor: null };
    }
    if (source.name === 'tasks') {
      throw new Error('boom');
    }
    return { items: ['c1'], nextCursor: null };
  };
  const agg = createDashboardAggregator({
    sources: SOURCES,
    fetcher,
    logger: silentLogger(log),
    timeoutMs: 50,
  });

  const result = await agg.getDashboard({});
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.missingSources.sort(), ['localstack', 'tasks']);
  assert.equal(result.cards.counter.count, 1, 'healthy sources still render');
  assert.equal(result.cards.localstack.count, 0);
  assert.ok(
    log.some((entry) => entry.status === 'partial'),
    'gateway log must carry the partial marker'
  );
});

test('empty collections and share math are divide-by-zero safe', async () => {
  const fetcher = async () => ({ items: [], nextCursor: null });
  const agg = createDashboardAggregator({ sources: SOURCES, fetcher, logger: silentLogger() });
  const result = await agg.getDashboard({});
  assert.equal(result.total, 0);
  for (const name of ['counter', 'localstack', 'tasks']) {
    assert.equal(result.cards[name].share, 0);
    assert.equal(result.cards[name].count, 0);
  }
  assert.equal(agg.shareOf(3, 0), 0);
  assert.equal(agg.shareOf(Number.NaN, 10), 0);
});

test('auth middleware rejects missing or invalid tokens with 401', async () => {
  const auth = createAuthMiddleware({ verifyToken: (t) => (t === 'good' ? { user: 1 } : null) });

  const resNoToken = mockRes();
  let nextCalled = false;
  auth({ headers: {} }, resNoToken, () => {
    nextCalled = true;
  });
  assert.equal(resNoToken.statusCode, 401);
  assert.equal(nextCalled, false);

  const resBadToken = mockRes();
  auth({ headers: { authorization: 'Bearer bad' } }, resBadToken, () => {});
  assert.equal(resBadToken.statusCode, 401);

  const resGood = mockRes();
  let passed = false;
  auth({ headers: { authorization: 'Bearer good' } }, resGood, () => {
    passed = true;
  });
  assert.equal(passed, true);
});

test('dashboard route mounts auth before the handler and returns 401 without a token', async () => {
  const routes = [];
  const app = {
    get(path, ...handlers) {
      routes.push({ path, handlers });
    },
  };
  const agg = createDashboardAggregator({
    sources: SOURCES,
    fetcher: async () => ({ items: [], nextCursor: null }),
    logger: silentLogger(),
  });
  registerDashboardRoutes(app, {
    aggregator: agg,
    authMiddleware: createAuthMiddleware({ verifyToken: () => null }),
  });

  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/api/dashboard');

  const res = mockRes();
  let handlerReached = false;
  const [auth, handler] = routes[0].handlers;
  auth({ headers: {}, query: {} }, res, () => {
    handlerReached = true;
  });
  assert.equal(res.statusCode, 401);
  assert.equal(handlerReached, false, '401 must short-circuit before the handler');
  void handler;
});

test('client clears the token and redirects to /login on 401', async () => {
  const removed = [];
  const redirects = [];
  const client = createDashboardClient({
    fetchImpl: async () => ({ status: 401, ok: false, json: async () => ({}) }),
    storage: {
      getItem: () => 'stale-token',
      removeItem: (k) => removed.push(k),
    },
    location: { replace: (url) => redirects.push(url) },
  });

  await assert.rejects(() => client.getDashboard(), /unauthorized/);
  assert.deepEqual(removed, ['dashboard_token']);
  assert.deepEqual(redirects, ['/login']);
});

test('client degrades to partial offline instead of throwing', async () => {
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
  assert.deepEqual(data.missingSources, ['counter', 'localstack', 'tasks']);
  assert.equal(data.offline, true);
});
