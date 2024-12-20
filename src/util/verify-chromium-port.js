import { createServer } from 'node:http';

import { UnusablePortError } from '../errors.js';

/**
 * Determine if a port is available
 * @param {number} port Port to test
 * */
async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.once('error', () => resolve(false));
    server.listen(port);
  });
}

/**
 * Validate that requested port is a valid port
 * @param {number} port Debugging port
 * @returns {boolean}
 */
function isPortValid(port) {
  if (!port) {
    return false;
  }
  if (Number.isNaN(port) || !Number.isInteger(port)) {
    throw new UnusablePortError(`Port provided is not an integer (${port})`);
  }
  if (port < 0 || port > 65535) {
    throw new UnusablePortError(`Invalid port number: ${port}`);
  }

  return true;
}

/**
 * Validate user-supplied port to ensure it is suitable for use
 * @param {number} port User-supplied port request
 * @param {string} chromiumBinary Chromium binary being requested for launch
 * @param {string[]} chromeFlags Array of flags requested for launch
 * @returns {boolean} Whether requested port is usable
 */
export async function validatePort(port) {
  if (!isPortValid(port)) {
    return false;
  }

  return isPortAvailable(port);
}
