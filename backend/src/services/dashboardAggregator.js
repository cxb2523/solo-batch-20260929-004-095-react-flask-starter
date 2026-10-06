'use strict';

const DEFAULT_TTL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 2000;
const MAX_PAGES = 100;

/**
 * Dashboard aggregation request wrapper.
 *
 * The route layer only mounts and authenticates; every data/aggregation
 * concern lives here:
 *
 *  Rule 1 - single snapshot: one snapshotId is generated per aggregation
 *           run and forwarded to every source and every page, so all
 *           cards are computed against the same point in time. Cursor
 *           pagination is drained with duplicate/loop protection, so
 *           items are neither repeated nor skipped.
 *  Rule 2 - single flight + TTL: concurrent calls with identical query
 *           params share one in-flight promise, and the resolved result
 *           is reused by later calls within a short TTL.
 *  Rule 3 - partial degradation: any source that times out or throws
 *           flips the whole response to `partial` and is listed in
 *           `missingSources`; healthy sources still produce cards.
 *  Rule 4 - divide-by-zero safety: empty collections and share math
 *           never produce NaN/Infinity.
 *
 * Options:
 *   sources  : [{ name }]
 *   fetcher  : async (source, params) => ({ items, nextCursor })
 *   logger   : { logRequest } (optional)
 *   ttlMs    : cached-result lifetime
 *   timeoutMs: per-source timeout
 */
function createDashboardAggregator({
  sources,
  fetcher,
  logger,
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
  newSnapshotId = () =>
    `snap-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
} = {}) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('dashboardAggregator: sources must be a non-empty array');
  }
  if (typeof fetcher !== 'function') {
    throw new Error('dashboardAggregator: fetcher(source, params) is required');
  }

  const inflight = new Map(); // key -> Promise
  const cache = new Map(); // key -> { expiresAt, result }

  function cacheKeyFor(params) {
    const entries = Object.keys(params || {})
      .sort()
      .map((key) => [key, String(params[key])]);
    return JSON.stringify(entries);
  }

  function withTimeout(promise, sourceName) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`source "${sourceName}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  // Drain a cursor-paginated source. A cursor we have already followed
  // means the upstream is looping: stop with what we have so nothing is
  // fetched twice.
  async function drainPages(source, baseParams) {
    const items = [];
    const followed = new Set();
    let cursor = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const pageParams = cursor === null ? baseParams : { ...baseParams, cursor };
      const response = await fetcher(source, pageParams);
      const pageItems = Array.isArray(response && response.items) ? response.items : [];
      items.push(...pageItems);

      const nextCursor = response && response.nextCursor;
      if (nextCursor === null || nextCursor === undefined || nextCursor === '') {
        break;
      }
      if (followed.has(nextCursor)) {
        break; // cursor loop -> stop, keep accumulated items (no dupes)
      }
      followed.add(nextCursor);
      cursor = nextCursor;
    }

    return items;
  }

  // Divide-by-zero / NaN safe ratio.
  function shareOf(part, total) {
    if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) {
      return 0;
    }
    return part / total;
  }

  function buildCards(itemsBySource) {
    let total = 0;
    for (const source of sources) {
      total += (itemsBySource[source.name] || []).length;
    }

    const cards = {};
    for (const source of sources) {
      const items = itemsBySource[source.name] || [];
      cards[source.name] = {
        count: items.length,
        share: shareOf(items.length, total),
        items,
      };
    }
    return { cards, total };
  }

  function log(status, snapshotId, cacheState, missingSources) {
    if (logger && typeof logger.logRequest === 'function') {
      logger.logRequest({
        route: '/api/dashboard',
        status,
        snapshotId,
        cache: cacheState,
        missingSources,
      });
    }
  }

  async function execute(params) {
    const snapshotId = newSnapshotId();
    const baseParams = { ...params, snapshot: snapshotId };

    const settled = await Promise.all(
      sources.map((source) =>
        withTimeout(drainPages(source, baseParams), source.name).then(
          (items) => ({ name: source.name, ok: true, items }),
          (error) => ({ name: source.name, ok: false, error })
        )
      )
    );

    const itemsBySource = {};
    const missingSources = [];
    for (const entry of settled) {
      itemsBySource[entry.name] = entry.ok ? entry.items : [];
      if (!entry.ok) missingSources.push(entry.name);
    }

    const status = missingSources.length === 0 ? 'ok' : 'partial';
    const { cards, total } = buildCards(itemsBySource);
    const result = { status, snapshotId, missingSources, cards, total };

    log(status, snapshotId, 'miss', missingSources);
    return result;
  }

  async function getDashboard(params = {}) {
    const key = cacheKeyFor(params);

    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) {
      log(cached.result.status, cached.result.snapshotId, 'hit', cached.result.missingSources);
      return cached.result;
    }

    // Identical params already in flight -> await the same promise once.
    if (inflight.has(key)) {
      return inflight.get(key);
    }

    const promise = execute(params)
      .then((result) => {
        cache.set(key, { expiresAt: now() + ttlMs, result });
        return result;
      })
      .finally(() => {
        inflight.delete(key);
      });

    inflight.set(key, promise);
    return promise;
  }

  return { getDashboard, shareOf };
}

module.exports = { createDashboardAggregator };
