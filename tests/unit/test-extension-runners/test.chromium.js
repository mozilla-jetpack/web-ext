import path from 'path';
import EventEmitter from 'events';

import { assert } from 'chai';
import { describe, it, beforeEach, afterEach } from 'mocha';
import deepcopy from 'deepcopy';
import fs from 'fs-extra';
import * as sinon from 'sinon';
import WebSocket from 'ws';

import getValidatedManifest from '../../../src/util/manifest.js';
import { basicManifest, StubChildProcess } from '../helpers.js';
import {
  ChromiumExtensionRunner,
  DEFAULT_CHROME_FLAGS,
} from '../../../src/extension-runners/chromium.js';
import {
  consoleStream, // instance is imported to inspect logged messages
} from '../../../src/util/logger.js';
import { TempDir, withTempDir } from '../../../src/util/temp-dir.js';
import fileExists from '../../../src/util/file-exists.js';
import isDirectory from '../../../src/util/is-directory.js';

function prepareExtensionRunnerParams({ params } = {}) {
  const fakeChromeInstance = {
    process: new StubChildProcess(),
    kill: sinon.spy(async () => {}),
  };
  const runnerParams = {
    extensions: [
      {
        sourceDir: '/fake/sourceDir',
        manifestData: deepcopy(basicManifest),
      },
    ],
    keepProfileChanges: false,
    startUrl: undefined,
    chromiumLaunch: sinon.spy(async () => {
      return fakeChromeInstance;
    }),
    desktopNotifications: sinon.spy(() => {}),
    ...(params || {}),
  };

  return { params: runnerParams, fakeChromeInstance };
}

describe('util/extension-runners/chromium', async () => {
  it('uses the expected chrome flags', () => {
    // Flags from chrome-launcher v0.14.0
    const expectedFlags = [
      '--disable-features=Translate,OptimizationHints,MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater,AutofillServerCommunication,PrivacySandboxSettings4',
      '--disable-component-extensions-with-background-pages',
      '--disable-background-networking',
      '--disable-client-side-phishing-detection',
      '--disable-sync',
      '--metrics-recording-only',
      '--disable-default-apps',
      '--no-default-browser-check',
      '--no-first-run',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--disable-ipc-flooding-protection',
      '--password-store=basic',
      '--use-mock-keychain',
      '--force-fieldtrials=*BackgroundTracing/default/',
      '--disable-hang-monitor',
      '--disable-prompt-on-repost',
      '--disable-domain-reliability',
      '--propagate-iph-for-testing',
    ];

    assert.deepEqual(DEFAULT_CHROME_FLAGS, expectedFlags);
  });

  it('installs and runs the extension', async () => {
    const { params, fakeChromeInstance } = prepareExtensionRunnerParams();
    const runnerInstance = new ChromiumExtensionRunner(params);
    assert.equal(runnerInstance.getName(), 'Chromium');

    await runnerInstance.run();

    const { reloadManagerExtension } = runnerInstance;

    sinon.assert.calledOnce(params.chromiumLaunch);
    sinon.assert.calledWithMatch(params.chromiumLaunch, {
      ignoreDefaultFlags: true,
      enableExtensions: true,
      chromePath: undefined,
      chromeFlags: [
        ...DEFAULT_CHROME_FLAGS,
        `--load-extension=${reloadManagerExtension},/fake/sourceDir`,
      ],
      startingUrl: undefined,
    });

    await runnerInstance.exit();
    sinon.assert.calledOnce(fakeChromeInstance.kill);
  });

  it('installs a "reload manager" companion extension', async () => {
    const { params } = prepareExtensionRunnerParams();
    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    const { reloadManagerExtension } = runnerInstance;

    assert.equal(await fs.exists(reloadManagerExtension), true);
    const managerExtManifest = await getValidatedManifest(
      reloadManagerExtension,
    );
    assert.deepEqual(managerExtManifest.permissions, ['management', 'tabs']);

    await runnerInstance.exit();
  });

  it(
    'does insert special urls in companion extension ' +
      '& excludes them from args',
    async () => {
      const { params } = prepareExtensionRunnerParams({
        params: {
          startUrl: [
            'url1',
            'chrome://version',
            'url2',
            'chrome://extensions',
            'chrome-extension://id/page.html',
          ],
        },
      });
      const runnerInstance = new ChromiumExtensionRunner(params);
      await runnerInstance.run();

      const { reloadManagerExtension } = runnerInstance;

      assert.equal(await fs.exists(reloadManagerExtension), true);

      const bgScript = path.join(reloadManagerExtension, 'bg.js');
      const expectedStr =
        'const chromeTabList = ["chrome://version","chrome://extensions","chrome-extension://id/page.html"]';
      assert.include(
        await fs.readFile(bgScript, 'utf8'),
        expectedStr,
        'bg.js does not contain special urls'
      );

      sinon.assert.calledOnce(params.chromiumLaunch);
      //assert special urls are not present
      sinon.assert.calledWithMatch(params.chromiumLaunch, {
        ignoreDefaultFlags: true,
        enableExtensions: true,
        chromePath: undefined,
        chromeFlags: [
          ...DEFAULT_CHROME_FLAGS,
          'url2',
          `--load-extension=${reloadManagerExtension},/fake/sourceDir`,
        ],
        startingUrl: 'url1',
      });

      await runnerInstance.exit();
    }
  );

  it('controls the "reload manager" from a websocket server', async () => {
    const { params } = prepareExtensionRunnerParams();
    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    const wssInfo = runnerInstance.wss.address();
    const wsURL = `ws://${wssInfo.address}:${wssInfo.port}`;
    const wsClient = new WebSocket(wsURL);

    await new Promise((resolve) => wsClient.on('open', resolve));

    // Clear console stream from previous messages and start recording
    consoleStream.stopCapturing();
    consoleStream.flushCapturedLogs();
    consoleStream.startCapturing();
    // Make verbose to capture debug logs.
    consoleStream.makeVerbose();

    // Emit a fake socket object as a new wss connection.

    const fakeSocket = new EventEmitter();
    sinon.spy(fakeSocket, 'on');
    runnerInstance.wss?.emit('connection', fakeSocket);
    sinon.assert.calledOnce(fakeSocket.on);

    fakeSocket.emit('error', new Error('Fake wss socket ERROR'));

    // Retrieve captures logs and stop capturing.
    const { capturedMessages } = consoleStream;
    consoleStream.stopCapturing();

    assert.ok(
      capturedMessages.some(
        (message) =>
          message.match('[debug]') && message.match('Fake wss socket ERROR'),
      ),
    );

    const reload = (client, resolve, data) => {
      client.send(JSON.stringify({ type: 'webExtReloadExtensionComplete' }));
      resolve(data);
    };

    const waitForReloadAll = new Promise((resolve) =>
      wsClient.on('message', (data) => reload(wsClient, resolve, data)),
    );
    await runnerInstance.reloadAllExtensions();
    assert.deepEqual(JSON.parse(await waitForReloadAll), {
      type: 'webExtReloadAllExtensions',
    });

    // TODO(rpl): change this once we improve the manager extension to be able
    // to reload a single extension.
    const waitForReloadOne = new Promise((resolve) =>
      wsClient.on('message', (data) => reload(wsClient, resolve, data)),
    );
    await runnerInstance.reloadExtensionBySourceDir('/fake/sourceDir');
    assert.deepEqual(JSON.parse(await waitForReloadOne), {
      type: 'webExtReloadAllExtensions',
    });

    // Verify that if one websocket connection gets closed, a second websocket
    // connection still receives the control messages.
    const wsClient2 = new WebSocket(wsURL);
    await new Promise((resolve) => wsClient2.on('open', resolve));
    wsClient.close();

    const waitForReloadClient2 = new Promise((resolve) =>
      wsClient2.on('message', (data) => reload(wsClient2, resolve, data)),
    );

    await runnerInstance.reloadAllExtensions();
    assert.deepEqual(JSON.parse(await waitForReloadClient2), {
      type: 'webExtReloadAllExtensions',
    });

    const waitForReloadAllAgain = new Promise((resolve) =>
      wsClient2.on('message', (data) => reload(wsClient2, resolve, data)),
    );
    await runnerInstance.reloadAllExtensions();
    assert.deepEqual(JSON.parse(await waitForReloadAllAgain), {
      type: 'webExtReloadAllExtensions',
    });

    await runnerInstance.exit();
  });

  it('exits if the chrome instance is shutting down', async () => {
    const { params, fakeChromeInstance } = prepareExtensionRunnerParams();
    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    const onceExiting = new Promise((resolve) =>
      runnerInstance.registerCleanup(resolve),
    );

    fakeChromeInstance.process.emit('close');

    await onceExiting;
  });

  it('calls all cleanup callbacks on exit', async () => {
    const { params } = prepareExtensionRunnerParams();
    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    runnerInstance.registerCleanup(function fnThrowsError() {
      throw new Error('fake cleanup exception');
    });

    const onceExiting = new Promise((resolve) =>
      runnerInstance.registerCleanup(resolve),
    );

    await runnerInstance.exit();
    await onceExiting;
  });

  it('does not call exit if chrome instance exits while shutting down', async () => {
    const { params, fakeChromeInstance } = prepareExtensionRunnerParams();
    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    sinon.spy(runnerInstance, 'exit');

    const exitDone = runnerInstance.exit();
    fakeChromeInstance.process.emit('close');

    await exitDone;

    sinon.assert.calledOnce(runnerInstance.exit);
  });

  it('awaits for the async setup to complete before exiting', async () => {
    const { params } = prepareExtensionRunnerParams({
      params: {
        chromiumLaunch: sinon.spy(async () => {
          throw new Error('Fake chromiumLaunch ERROR');
        }),
      },
    });
    const runnerInstance = new ChromiumExtensionRunner(params);
    assert.equal(runnerInstance.getName(), 'Chromium');

    await assert.isRejected(runnerInstance.run(), /Fake chromiumLaunch ERROR/);

    // Clear console stream from previous messages and start recording
    consoleStream.stopCapturing();
    consoleStream.flushCapturedLogs();
    consoleStream.startCapturing();
    // Make verbose to capture debug logs.
    consoleStream.makeVerbose();

    // Call exit and then verify that it caught the chromiumLaunch rejection
    // and logged it as a debug log.
    await runnerInstance.exit();

    // Retrieve captures logs and stop capturing.
    const { capturedMessages } = consoleStream;
    consoleStream.stopCapturing();

    assert.ok(
      capturedMessages.some(
        (message) =>
          message.match('[debug]') &&
          message.match('ignored setup error on chromium runner shutdown') &&
          message.match('Fake chromiumLaunch ERROR'),
      ),
    );
  });

  it('does use a custom chromium binary when passed', async () => {
    const { params } = prepareExtensionRunnerParams({
      params: { chromiumBinary: '/my/custom/chrome-bin' },
    });

    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    const { reloadManagerExtension } = runnerInstance;

    sinon.assert.calledOnce(params.chromiumLaunch);
    sinon.assert.calledWithMatch(params.chromiumLaunch, {
      ignoreDefaultFlags: true,
      enableExtensions: true,
      chromePath: '/my/custom/chrome-bin',
      chromeFlags: [
        ...DEFAULT_CHROME_FLAGS,
        `--load-extension=${reloadManagerExtension},/fake/sourceDir`,
      ],
      startingUrl: undefined,
    });

    await runnerInstance.exit();
  });

  it('does pass multiple starting urls to chrome', async () => {
    const { params } = prepareExtensionRunnerParams({
      params: { startUrl: ['url1', 'url2', 'url3'] },
    });

    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    const { reloadManagerExtension } = runnerInstance;

    sinon.assert.calledOnce(params.chromiumLaunch);
    sinon.assert.calledWithMatch(params.chromiumLaunch, {
      ignoreDefaultFlags: true,
      enableExtensions: true,
      chromePath: undefined,
      chromeFlags: [
        ...DEFAULT_CHROME_FLAGS,
        'url2',
        'url3',
        `--load-extension=${reloadManagerExtension},/fake/sourceDir`,
      ],
      startingUrl: 'url1',
    });

    await runnerInstance.exit();
  });

  it('does pass additional args to chrome', async () => {
    const { params } = prepareExtensionRunnerParams({
      params: {
        args: ['--arg1', 'arg2', '--arg3'],
        startUrl: ['url1', 'url2', 'url3'],
      },
    });

    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    const { reloadManagerExtension } = runnerInstance;

    sinon.assert.calledOnce(params.chromiumLaunch);
    sinon.assert.calledWithMatch(params.chromiumLaunch, {
      ignoreDefaultFlags: true,
      enableExtensions: true,
      chromePath: undefined,
      chromeFlags: [
        ...DEFAULT_CHROME_FLAGS,
        'url2',
        'url3',
        `--load-extension=${reloadManagerExtension},/fake/sourceDir`,
        '--arg1',
        'arg2',
        '--arg3',
      ],
      startingUrl: 'url1',
    });

    await runnerInstance.exit();
  });

  it('does use a random user-data-dir', async () => {
    const { params } = prepareExtensionRunnerParams({
      params: {},
    });

    const spy = sinon.spy(TempDir.prototype, 'path');

    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    const usedTempPath = spy.returnValues[2];

    sinon.assert.calledWithMatch(params.chromiumLaunch, {
      userDataDir: usedTempPath,
    });

    await runnerInstance.exit();
    spy.restore();
  });

  it('does pass a user-data-dir flag to chrome', async () =>
    withTempDir(async (tmpDir) => {
      const { params } = prepareExtensionRunnerParams({
        params: {
          chromiumProfile: tmpDir.path(),
        },
      });

      const spy = sinon.spy(TempDir.prototype, 'path');

      const runnerInstance = new ChromiumExtensionRunner(params);
      await runnerInstance.run();

      const usedTempPath = spy.returnValues[2];

      const { reloadManagerExtension } = runnerInstance;

      sinon.assert.calledOnce(params.chromiumLaunch);
      sinon.assert.calledWithMatch(params.chromiumLaunch, {
        ignoreDefaultFlags: true,
        enableExtensions: true,
        chromePath: undefined,
        userDataDir: usedTempPath,
        chromeFlags: [
          ...DEFAULT_CHROME_FLAGS,
          `--load-extension=${reloadManagerExtension},/fake/sourceDir`,
        ],
        startingUrl: undefined,
      });

      await runnerInstance.exit();
      spy.restore();
    }));

  it(
    'does pass existing user-data-dir and profile-directory flag' +
      ' to chrome',
    async () =>
      withTempDir(async (tmpDir) => {
        const tmpPath = tmpDir.path();
        await fs.mkdirs(path.join(tmpPath, 'userDataDir/Default'));
        await fs.outputFile(path.join(tmpPath, 'userDataDir/Local State'), '');
        await fs.mkdirs(path.join(tmpPath, 'userDataDir/profile'));
        await fs.outputFile(
          path.join(tmpPath, 'userDataDir/profile/Secure Preferences'),
          '',
        );

        const { params } = prepareExtensionRunnerParams({
          params: {
            chromiumProfile: path.join(tmpPath, 'userDataDir/profile'),
            keepProfileChanges: true,
          },
        });

        const runnerInstance = new ChromiumExtensionRunner(params);
        await runnerInstance.run();

        const { reloadManagerExtension } = runnerInstance;

        sinon.assert.calledOnce(params.chromiumLaunch);
        sinon.assert.calledWithMatch(params.chromiumLaunch, {
          ignoreDefaultFlags: true,
          enableExtensions: true,
          chromePath: undefined,
          userDataDir: path.join(tmpPath, 'userDataDir'),
          chromeFlags: [
            ...DEFAULT_CHROME_FLAGS,
            `--load-extension=${reloadManagerExtension},/fake/sourceDir`,
            '--profile-directory=profile',
          ],
          startingUrl: undefined,
        });

        await runnerInstance.exit();
      }),
  );

  it('does support some special chars in profile-directory flag', async () =>
    withTempDir(async (tmpDir) => {
      const tmpPath = tmpDir.path();
      // supported to test: [ _-]
      // not supported by Chromium: [ßäé]
      const profileDirName = " profile _-' ";
      await fs.mkdirs(path.join(tmpPath, 'userDataDir/Default'));
      await fs.outputFile(path.join(tmpPath, 'userDataDir/Local State'), '');
      await fs.mkdirs(path.join(tmpPath, 'userDataDir', profileDirName));
      await fs.outputFile(
        path.join(tmpPath, 'userDataDir', profileDirName, 'Secure Preferences'),
        '',
      );

      const { params } = prepareExtensionRunnerParams({
        params: {
          chromiumProfile: path.join(tmpPath, 'userDataDir', profileDirName),
          keepProfileChanges: true,
        },
      });

      const runnerInstance = new ChromiumExtensionRunner(params);
      await runnerInstance.run();

      const { reloadManagerExtension } = runnerInstance;

      sinon.assert.calledOnce(params.chromiumLaunch);
      sinon.assert.calledWithMatch(params.chromiumLaunch, {
        ignoreDefaultFlags: true,
        enableExtensions: true,
        chromePath: undefined,
        userDataDir: path.join(tmpPath, 'userDataDir'),
        chromeFlags: [
          ...DEFAULT_CHROME_FLAGS,
          `--load-extension=${reloadManagerExtension},/fake/sourceDir`,
          `--profile-directory=${profileDirName}`,
        ],
        startingUrl: undefined,
      });

      await runnerInstance.exit();
    }));

  it('does recognize a UserData dir', async () =>
    withTempDir(async (tmpDir) => {
      const tmpPath = tmpDir.path();
      await fs.mkdirs(path.join(tmpPath, 'Default'));
      await fs.outputFile(path.join(tmpPath, 'Local State'), '');

      assert.isTrue(await ChromiumExtensionRunner.isUserDataDir(tmpPath));
    }));

  it('does reject a UserData dir with Local State dir', async () =>
    withTempDir(async (tmpDir) => {
      const tmpPath = tmpDir.path();
      await fs.mkdirs(path.join(tmpPath, 'Default'));
      // Local State should be a file
      await fs.mkdirs(path.join(tmpPath, 'Local State'));

      assert.isFalse(await ChromiumExtensionRunner.isUserDataDir(tmpPath));
    }));

  it('does reject a UserData dir with Default file', async () =>
    withTempDir(async (tmpDir) => {
      const tmpPath = tmpDir.path();
      await fs.mkdirs(path.join(tmpPath, 'Local State'));
      // Default should be a directory
      await fs.outputFile(path.join(tmpPath, 'Default'), '');

      assert.isFalse(await ChromiumExtensionRunner.isUserDataDir(tmpPath));
    }));

  it('throws an error on profile in invalid user-data-dir', async () =>
    withTempDir(async (tmpDir) => {
      const tmpPath = tmpDir.path();
      await fs.mkdirs(path.join(tmpPath, 'userDataDir/profile'));
      // the userDataDir is missing a file Local State to be validated as such
      await fs.outputFile(
        path.join(tmpPath, 'userDataDir/profile/Secure Preferences'),
        '',
      );

      const { params } = prepareExtensionRunnerParams({
        params: {
          chromiumProfile: path.join(tmpPath, 'userDataDir/profile'),
          keepProfileChanges: true,
        },
      });

      const runnerInstance = new ChromiumExtensionRunner(params);

      await assert.isRejected(runnerInstance.run(), /not in a user-data-dir/);

      await runnerInstance.exit();
    }));

  it(
    'does copy the profile and pass user-data-dir and profile-directory' +
      ' flags',
    async () =>
      withTempDir(async (tmpDir) => {
        const tmpPath = tmpDir.path();
        await fs.mkdirs(path.join(tmpPath, 'userDataDir/profile'));
        await fs.outputFile(
          path.join(tmpPath, 'userDataDir/profile/Secure Preferences'),
          '',
        );

        const { params } = prepareExtensionRunnerParams({
          params: {
            chromiumProfile: path.join(tmpPath, 'userDataDir/profile'),
          },
        });

        const spy = sinon.spy(TempDir.prototype, 'path');

        const runnerInstance = new ChromiumExtensionRunner(params);
        await runnerInstance.run();

        const usedTempPath = spy.returnValues[2];

        const { reloadManagerExtension } = runnerInstance;

        sinon.assert.calledOnce(params.chromiumLaunch);
        sinon.assert.calledWithMatch(params.chromiumLaunch, {
          ignoreDefaultFlags: true,
          enableExtensions: true,
          chromePath: undefined,
          userDataDir: usedTempPath,
          chromeFlags: [
            ...DEFAULT_CHROME_FLAGS,
            `--load-extension=${reloadManagerExtension},/fake/sourceDir`,
            '--profile-directory=profile',
          ],
          startingUrl: undefined,
        });

        assert.isTrue(await isDirectory(path.join(usedTempPath, 'profile')));
        assert.isTrue(
          await fileExists(
            path.join(usedTempPath, 'profile/Secure Preferences'),
          ),
        );

        await runnerInstance.exit();
        spy.restore();
      }),
  );

  describe('reloadAllExtensions', () => {
    let runnerInstance;
    let wsClient;

    beforeEach(async () => {
      const { params } = prepareExtensionRunnerParams();
      runnerInstance = new ChromiumExtensionRunner(params);
      await runnerInstance.run();
    });

    const connectClient = async () => {
      if (!runnerInstance.wss) {
        throw new Error('WebSocker server is not running');
      }
      const wssInfo = runnerInstance.wss.address();
      const wsURL = `ws://${wssInfo.address}:${wssInfo.port}`;
      wsClient = new WebSocket(wsURL);
      await new Promise((resolve) => wsClient.on('open', resolve));
    };

    afterEach(async () => {
      if (wsClient && wsClient.readyState === WebSocket.OPEN) {
        wsClient.close();
        wsClient = null;
      }
      await runnerInstance.exit();
    });

    it('does not resolve before complete message from client', async () => {
      let reloadMessage = false;
      await connectClient();

      wsClient.on('message', (message) => {
        const msg = JSON.parse(message);

        if (msg.type === 'webExtReloadAllExtensions') {
          assert.equal(reloadMessage, false);

          setTimeout(() => {
            const respondMsg = JSON.stringify({
              type: 'webExtReloadExtensionComplete',
            });
            wsClient.send(respondMsg);
            reloadMessage = true;
          }, 333);
        }
      });

      await runnerInstance.reloadAllExtensions();
      assert.equal(reloadMessage, true);
    });

    it('resolve when any client send complete message', async () => {
      await connectClient();
      wsClient.on('message', () => {
        const msg = JSON.stringify({ type: 'webExtReloadExtensionComplete' });
        wsClient.send(msg);
      });
      await runnerInstance.reloadAllExtensions();
    });

    it('resolve when all client disconnect', async () => {
      await connectClient();
      await new Promise((resolve) => {
        wsClient.on('close', () => {
          resolve(runnerInstance.reloadAllExtensions());
        });
        wsClient.close();
      });
      wsClient = null;
    });

    it('resolve when not client connected', async () => {
      await runnerInstance.reloadAllExtensions();
    });
  });
});
