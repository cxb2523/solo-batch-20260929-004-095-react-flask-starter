'use strict';

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '..', '..', 'logs', 'gateway.log');

/**
 * Minimal gateway logger. Writes structured lines to stdout and appends
 * them to logs/gateway.log so the partial marker can be grepped later.
 */
function createGatewayLogger({ file = LOG_FILE, stdout = process.stdout } = {}) {
  function write(line) {
    stdout.write(line + '\n');
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line + '\n');
    } catch {
      // Logging must never break the request path.
    }
  }

  return {
    logRequest({ route, status, missingSources = [], snapshotId, cache }) {
      const missing = missingSources.length ? missingSources.join(',') : '-';
      write(
        `[gateway] route=${route} status=${status} snapshot=${snapshotId} ` +
          `cache=${cache} missing=${missing}`
      );
    },
  };
}

module.exports = { createGatewayLogger };
