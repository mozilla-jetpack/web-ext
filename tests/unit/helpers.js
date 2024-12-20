import path from 'path';
import EventEmitter from 'events';
import stream from 'stream';
import { promisify } from 'util';
import { fileURLToPath, pathToFileURL } from 'url';

import deepcopy from 'deepcopy';
import * as sinon from 'sinon';
import yauzl from 'yauzl';
import ExtendableError from 'es6-error';
import * as td from 'testdouble';

import { createLogger } from '../../src/util/logger.js';
import * as defaultFirefoxApp from '../../src/firefox/index.js';
import { RemoteFirefox } from '../../src/firefox/remote.js';

const log = createLogger(import.meta.url);

/*
 * A way to read zip files using promises for all the things.
 */
export class ZipFile {
  _zip;
  _close;

  constructor() {
    this._zip = null;
    this._close = null;
  }

  /*
   * Open a zip file and return a promise that resolves to a yauzl
   * zipfile object.
   */
  open(...args) {
    return promisify(yauzl.open)(...args).then((zip) => {
      this._zip = zip;
      this._close = new Promise((resolve) => {
        zip.once('close', resolve);
      });
    });
  }

  /**
   * Close the zip file and wait fd to release.
   */
  close() {
    this._zip.close();
    return this._close;
  }

  /*
   * After open(), readEach(onRead) will return a promise that resolves
   * when all entries have been read.
   *
   * The onRead callback receives a single argument, a yauzl Entry object.
   */
  readEach(onRead) {
    return new Promise((resolve, reject) => {
      if (!this._zip) {
        throw new Error(
          'Cannot operate on a falsey zip file. Call open() first.',
        );
      }

      this._zip.on('entry', (entry) => {
        onRead(entry);
      });

      this._zip.once('error', (error) => {
        reject(error);
      });

      this._zip.once('end', () => {
        resolve();
      });
    });
  }

  /*
   * Resolve a promise with an array of all file names in the zip archive.
   */
  extractFilenames() {
    return new Promise((resolve, reject) => {
      var fileNames = [];
      this.readEach((entry) => {
        fileNames.push(entry.fileName);
      })
        .then(() => {
          resolve(fileNames);
        })
        .catch((error) => {
          reject(error);
        });
    });
  }
}

/*
 * Returns a path to a test fixture file. Invoke it the same as path.join().
 */
export function fixturePath(...pathParts) {
  return path.join(
    moduleURLToDirname(import.meta.url),
    '..',
    'fixtures',
    ...pathParts,
  );
}

/*
 * Test helper to make sure a promise chain really fails.
 *
 * Usage:
 *
 *  Promise.reject(new Error('some error'))
 *    .then(makeSureItFails(), (error) => {
 *      // Safely make assertions about the error...
 *    });
 */
export function makeSureItFails() {
  return () => {
    throw new Error('This test unexpectedly succeeded without an error');
  };
}

/*
 * Return a fake version of an object for testing.
 *
 * The fake object will contain stub implementations of
 * all original methods. Each method will be wrapped in
 * a sinon.spy() for inspection.
 *
 * You can optionally provide implementations for one or
 * more methods.
 *
 * Unlike similar sinon helpers, this *does not* touch the
 * original object so there is no need to tear down any
 * patches afterwards.
 *
 * Usage:
 *
 * let fakeProcess = fake(process, {
 *   cwd: () => '/some/directory',
 * });
 *
 * // Use the object in real code:
 * fakeProcess.cwd();
 *
 * // Make assertions about methods that
 * // were on the original object:
 * assert.equal(fakeProcess.exit.called, true);
 *
 */

export function fake(original, methods = {}, skipProperties = []) {
  const stub = {};
  // Provide stubs for all original members (fallback to Object if original
  // doesn't have a defined prototype):
  const proto = Object.getPrototypeOf(original) || Object;
  const props = Object.getOwnPropertyNames(original)
    .concat(Object.getOwnPropertyNames(proto))
    .filter((key) => !skipProperties.includes(key));

  for (const key of props) {
    const definition = original[key] || proto[key];
    if (typeof definition === 'function') {
      stub[key] = () => {
        log.warn(`Running stubbed function ${key} (default implementation)`);
      };
    }
  }

  // Provide custom implementations, if necessary.
  Object.keys(methods).forEach((key) => {
    if (!original[key]) {
      throw new Error(
        `Cannot define method "${key}"; it does not exist on the original`,
      );
    }
    stub[key] = methods[key];
  });

  // Wrap all implementations in spies.
  Object.keys(stub).forEach((key) => {
    stub[key] = sinon.spy(stub[key]);
  });

  return stub;
}

export class StubChildProcess extends EventEmitter {
  stderr = new EventEmitter();
  stdout = new EventEmitter();
  kill = sinon.spy(() => {});

  constructor(params = {}) {
    super();

    // mimic chrome-launch and set a port property, defaulting to a random port
    this.port = params.chromiumPort
      ? params.chromiumPort
      : getRandomInt(1024, 65536);
  }
}

export function createFakeProcess() {
  return fake(process, {}, ['EventEmitter', 'stdin']);
}

/*
 * Returns a fake FirefoxRDPClient as would be returned by
 * rdp-module connectToFirefox().
 */
export function fakeFirefoxClient() {
  return {
    disconnect: sinon.spy(() => {}),
    on: () => {},
    request: sinon.stub().resolves({}),
  };
}

/*
 * A simulated TCP connection error.
 *
 * By default, the error code will be ECONNREFUSED.
 */
export class TCPConnectError extends ExtendableError {
  code;
  constructor(msg = 'simulated connection error') {
    super(msg);
    this.code = 'ECONNREFUSED';
  }
}

export class ErrorWithCode extends Error {
  code;
  constructor(code, message) {
    super(`${code || ''}: ${message || 'pretend this is a system error'}`);
    this.code = code || 'SOME_CODE';
  }
}

/*
 * A basic manifest fixture used in unit tests.
 */
export const basicManifest = {
  name: 'the extension',
  version: '0.0.1',
  applications: {
    gecko: {
      id: 'basic-manifest@web-ext-test-suite',
    },
  },
};

/*
 * A basic manifest fixture without an applications property.
 */
export const manifestWithoutApps = deepcopy(basicManifest);
delete manifestWithoutApps.applications;

/*
 * A class that implements an empty IExtensionRunner interface.
 */
export class FakeExtensionRunner {
  params;

  constructor(params) {
    this.params = params;
  }

  getName() {
    return 'Fake Extension Runner';
  }

  async run() {}
  async exit() {}
  async reloadAllExtensions() {
    return [];
  }
  async reloadExtensionBySourceDir(sourceDir) {
    const runnerName = this.getName();
    return [{ runnerName, sourceDir }];
  }
  registerCleanup(fn) {} // eslint-disable-line no-unused-vars
}

export function getFakeFirefox(implementations = {}, port = 6005) {
  const profile = {}; // empty object just to avoid errors.
  const firefox = () => Promise.resolve();
  const allImplementations = {
    createProfile: () => Promise.resolve(profile),
    copyProfile: () => Promise.resolve(profile),
    useProfile: () => Promise.resolve(profile),
    installExtension: () => Promise.resolve(),
    run: () => Promise.resolve({ firefox, debuggerPort: port }),
    ...implementations,
  };
  return fake(defaultFirefoxApp, allImplementations);
}

export function getFakeRemoteFirefox(implementations = {}) {
  return fake(RemoteFirefox.prototype, implementations);
}

class FakeStdin extends stream.Readable {
  get isTTY() {
    return true;
  }

  // Fake tty.ReadStream methods.
  setRawMode() {}
  _read() {}
}

export function createFakeStdin() {
  return new FakeStdin();
}

export function moduleURLToDirname(moduleURL) {
  if (!moduleURL) {
    throw new Error('Unexpected undefined module url');
  }
  return path.dirname(fileURLToPath(moduleURL));
}

export function mockModule({
  moduleURL,
  importerModuleURL,
  namedExports,
  defaultExport,
}) {
  // Compute the full URL to the module to mock, otherwise
  // quibble will compute the wrong module URL when running
  // on windows (which would be looking as "C:\\C:\\Users\\...").
  const baseDir = path.dirname(fileURLToPath(importerModuleURL));
  const fullModuleURL = pathToFileURL(
    path.resolve(path.join(baseDir, moduleURL)),
  ).href;

  td.replaceEsm(fullModuleURL, namedExports, defaultExport);
}

export function resetMockModules() {
  td.reset();
}

export function getRandomInt(min, max) {
  const _min = Math.ceil(min);
  const _max = Math.floor(max);
  return Math.floor(Math.random() * (_max - _min) + _min);
}
