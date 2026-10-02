'use strict';

/**
 * Client-side request wrapper for the dashboard endpoint.
 *
 * - Attaches the stored Bearer token.
 * - On 401 (or any auth-invalid response) clears the token and redirects
 *   to /login immediately — no half-logged-in state.
 * - On network failure returns a synthetic `partial` payload listing every
 *   known source as missing, so the page degrades instead of crashing.
 *
 * Works in the browser (script tag) and in Node (module.exports) so the
 * 401 branch is unit-testable.
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
      (typeof fetch !== 'undefined'
        ? fetch.bind(typeof self !== 'undefined' ? self : globalThis)
        : null);
    const store =
      storage ||
      (typeof localStorage !== 'undefined'
        ? localStorage
        : { getItem: () => null, removeItem: () => {} });
    const loc = location || (typeof window !== 'undefined' ? window.location : null);

    function forceLogout() {
      try {
        store.removeItem(tokenKey);
      } catch {
        /* storage may be unavailable; still redirect */
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
      } catch (err) {
        // Offline / network down: degrade, never throw.
        return degradedPayload(String((err && err.message) || err));
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
