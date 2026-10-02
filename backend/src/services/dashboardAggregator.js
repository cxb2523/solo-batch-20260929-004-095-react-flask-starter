'use strict';

const DEFAULT_TTL_MS = 3000;
const DEFAULT_TIMEOUT_MS = 2000;
const MAX_PAGES = 100;

/**
 * Dashboard aggregation request wrapper.
 *
 * Rules enforced here:
 *  1. Every source is queried with the same snapshotId, and paginated
 *     sources are drained via cursor with duplicate/loop protection, so
 *     pages are never duplicated or skipped.
 *  2. Identical query params share a single in-flight request; the
 *     resolved result is reused for a short TTL.
 *  3. A source that times out or errors degrades the whole response to
 *     `partial` and its name is reported in `missingSources`; the rest
 *     of the cards are still returned.
 *  4. Empty collections and share/percentage math are divide-by-zero safe.
 */
function createDashboardAggregator({
  sources,
  fetcher,
  logger,
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = () => Date.now(),
  newSnapshotId = () => `snap-${now()}-${Math.random().toString(36).slice(2, 10)}`,
}) {
  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error('dashboard aggregator requires at least one source');
  }
  if (typeof fetcher !== 'function') {
    throw new Error('dashboard aggregator requires a fetcher(source, params)');
  }

  const inflight = new Map(); // cacheKey -> Promise<result>
  const cache = new Map(); // cacheKey -> { expiresAt, result }

  function cacheKeyFor(params) {
    const sorted = Object.keys(params || {})
      .sort()
      .map((k) => [k, String(params[k])]);
    return JSON.stringify(sorted);
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
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  // Drain a paginated source: follow nextCursor until exhausted.
  // A repeated cursor means the upstream is looping — stop instead of
  // duplicating items.
  async function fetchAllPages(source, baseParams) {
    const items = [];
    const seenCursors = new Set();
    let cursor = null;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const pageParams = cursor === null ? baseParams : { ...baseParams, cursor };
      const response = await fetcher(source, pageParams);
      const pageItems = Array.isArray(response && response.items) ? response.items : [];
      items.push(...pageItems);

      const nextCursor = response && response.nextCursor;
      if (nextCursor === null || nextCursor === undefined || nextCursor === '') {
        return items;
      }
      if (seenCursors.has(nextCursor)) {
        return items; // cursor loop: stop, keep what we have (no duplicates)
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    return items;
  }

  // Divide-by-zero safe share calculation.
  function shareOf(part, total) {
    if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
    return part / total;
  }

  function summarize(itemsBySource) {
    const cards = {};
    let grandTotal = 0;
    for (const source of sources) {
      const items = itemsBySource[source.name] || [];
      grandTotal += items.length;
    }
    for (const source of sources) {
      const items = itemsBySource[source.name] || [];
      cards[source.name] = {
        count: items.length,
        share: shareOf(items.length, grandTotal),
        items,
      };
    }
    return { cards, total: grandTotal };
  }

  async function execute(params) {
    const snapshotId = newSnapshotId();
    const baseParams = { ...params, snapshot: snapshotId };

    const settled = await Promise.all(
      sources.map((source) =>
        withTimeout(fetchAllPages(source, baseParams), source.name).then(
          (items) => ({ name: source.name, ok: true, items }),
          (err) => ({ name: source.name, ok: false, error: err })
        )
      )
    );

    const itemsBySource = {};
    const missingSources = [];
    for (const entry of settled) {
      if (entry.ok) {
        itemsBySource[entry.name] = entry.items;
      } else {
        itemsBySource[entry.name] = [];
        missingSources.push(entry.name);
      }
    }

    const status = missingSources.length === 0 ? 'ok' : 'partial';
    const { cards, total } = summarize(itemsBySource);
    const result = { status, snapshotId, missingSources, cards, total };

    if (logger) {
      logger.logRequest({
        route: '/api/dashboard',
        status,
        missingSources,
        snapshotId,
        cache: 'miss',
      });
    }
    return result;
  }

  async function getDashboard(params = {}) {
    const key = cacheKeyFor(params);

    const cached = cache.get(key);
    if (cached && cached.expiresAt > now()) {
      if (logger) {
        logger.logRequest({
          route: '/api/dashboard',
          status: cached.result.status,
          missingSources: cached.result.missingSources,
          snapshotId: cached.result.snapshotId,
          cache: 'hit',
        });
      }
      return cached.result;
    }

    // Same params while a request is in flight -> reuse the same promise.
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
