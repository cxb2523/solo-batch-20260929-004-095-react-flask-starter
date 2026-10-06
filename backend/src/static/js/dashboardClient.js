'use strict';

/**
 * Browser-side dashboard request wrapper.
 *
 *  - Attaches the stored Bearer token to every request.
 *  - On 401 (expired/invalid session) it removes the token and redirects
 *    to /login immediately, then rejects: there is no half-logged-in
 *    state where stale cards keep rendering.
 *  - On a network failure (offline refresh) it resolves a synthetic
 *    `partial` payload listing every known source as missing, so the
 *    debug page degrades gracefully instead of crashing.
 *
 * UMD-style export so it works both via <script> in the debug page and
 * via require() in the Node test suite.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.createDashboardClient = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function createDashboardClient({
    fetchImpl,
    storage,
    location,
    endpoint = '/api/dashboard',
    knownSources = [],
    tokenKey = 'dashboard_token',
    loginPath = '/login',
  } = {}) {
    const doFetch =
      fetchImpl ||
      (typeof fetch === 'function'
        ? fetch.bind(typeof self !== 'undefined' ? self : globalThis)
        : null);
    const store =
      storage ||
      (typeof localStorage !== 'undefined'
        ? localStorage
        : { getItem: () => null, removeItem: () => {} });
    const loc =
      location || (typeof window !== 'undefined' ? window.location : null);

    function forceLogout() {
      try {
        store.removeItem(tokenKey);
      } catch {
        // Storage may be unavailable; the redirect still has to happen.
      }
      if (loc && typeof loc.replace === 'function') {
        loc.replace(loginPath);
      }
    }

    function degradedPayload(reason) {
      return {
        status: 'partial',
        snapshotId: null,
        missingSources: knownSources.slice(),
        cards: {},
        total: 0,
        offline: true,
        reason,
      };
    }

    async function getDashboard(params = {}) {
      const query = new URLSearchParams(params).toString();
      const url = query ? `${endpoint}?${query}` : endpoint;
      const token = store.getItem(tokenKey);

      let response;
      try {
        response = await doFetch(url, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
      } catch (error) {
        // Offline / network error: degrade to partial, never throw.
        return degradedPayload(String((error && error.message) || error));
      }

      if (response.status === 401) {
        forceLogout();
        throw new Error('unauthorized');
      }

      if (!response.ok) {
        return degradedPayload(`http ${response.status}`);
      }

      return response.json();
    }

    return { getDashboard, forceLogout };
  }

  return createDashboardClient;
});
