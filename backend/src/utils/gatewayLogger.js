'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LOG_FILE = path.join(__dirname, '..', '..', 'logs', 'gateway.log');

/**
 * Structured gateway logger. Each request emits one line to stdout and
 * appends the same line to logs/gateway.log, where the `status=partial`
 * marker can be grepped during acceptance / screen recording.
 */
function createGatewayLogger({ file = DEFAULT_LOG_FILE, stdout = process.stdout } = {}) {
  function emit(line) {
    stdout.write(`${line}\n`);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${line}\n`);
    } catch {
      // Never let logging break a request.
    }
  }

  return {
    logRequest({ route, status, snapshotId, cache, missingSources = [] }) {
      const missing = missingSources.length > 0 ? missingSources.join(',') : '-';
      emit(
        `[gateway] route=${route} status=${status} snapshot=${snapshotId} ` +
          `cache=${cache} missing=${missing}`
      );
    },
  };
}

module.exports = { createGatewayLogger };
