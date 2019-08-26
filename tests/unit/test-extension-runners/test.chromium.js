/* @flow */

import EventEmitter from 'events';

import {assert} from 'chai';
import {describe, it} from 'mocha';
import deepcopy from 'deepcopy';
import fs from 'mz/fs';
import sinon from 'sinon';
import ChromeLauncher from 'chrome-launcher';
import WebSocket from 'ws';

import getValidatedManifest from '../../../src/util/manifest';
import {
  basicManifest,
  StubChildProcess,
} from '../helpers';
import {
  ChromiumExtensionRunner,
} from '../../../src/extension-runners/chromium';
import type {
  ChromiumExtensionRunnerParams,
} from '../../../src/extension-runners/chromium';
import {
  consoleStream, // instance is imported to inspect logged messages
} from '../../../src/util/logger';

const defaultChromeFlags = ChromeLauncher.defaultFlags()
  .filter((flag) => flag !== '--disable-extensions');

function prepareExtensionRunnerParams({params} = {}) {
  const fakeChromeInstance = {
    process: new StubChildProcess(),
    kill: sinon.spy(async () => {}),
  };
  const runnerParams: ChromiumExtensionRunnerParams = {
    extensions: [{
      sourceDir: '/fake/sourceDir',
      manifestData: deepcopy(basicManifest),
    }],
    keepProfileChanges: false,
    startUrl: undefined,
    chromiumLaunch: sinon.spy(async () => {
      return fakeChromeInstance;
    }),
    desktopNotifications: sinon.spy(() => {}),
    ...(params || {}),
  };

  return {params: runnerParams, fakeChromeInstance};
}

describe('util/extension-runners/chromium', async () => {

  it('installs and runs the extension', async () => {
    const {params, fakeChromeInstance} = prepareExtensionRunnerParams();
    const runnerInstance = new ChromiumExtensionRunner(params);
    assert.equal(runnerInstance.getName(), 'Chromium');

    await runnerInstance.run();

    const {reloadManagerExtension} = runnerInstance;

    sinon.assert.calledOnce(params.chromiumLaunch);
    sinon.assert.calledWithMatch(params.chromiumLaunch, {
      ignoreDefaultFlags: true,
      enableExtensions: true,
      chromePath: undefined,
      chromeFlags: [
        ...defaultChromeFlags,
        `--load-extension=${reloadManagerExtension},/fake/sourceDir`,
      ],
      startingUrl: undefined,
    });

    await runnerInstance.exit();
    sinon.assert.calledOnce(fakeChromeInstance.kill);
  });

  it('installs a "reload manager" companion extension', async () => {
    const {params} = prepareExtensionRunnerParams();
    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    const {reloadManagerExtension} = runnerInstance;

    assert.equal(await fs.exists(reloadManagerExtension), true);
    const managerExtManifest = await getValidatedManifest(
      reloadManagerExtension);
    assert.deepEqual(managerExtManifest.permissions, ['management', 'tabs']);

    await runnerInstance.exit();
  });


  it('controls the "reload manager" from a websocket server', async () => {
    const {params} = prepareExtensionRunnerParams();
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
    const socket = await new Promise((resolve) => {
      const fakeSocket = new EventEmitter();

      const onFn = fakeSocket.on;
      // $FLOW_IGNORE: override read-only prop for testing purpose.
      fakeSocket.on = sinon.spy((...args) => {
        onFn.apply(fakeSocket, args);
        resolve(fakeSocket);
      });

      runnerInstance.wss.emit('connection', fakeSocket);
    });

    sinon.assert.calledOnce(socket.on);
    socket.emit('error', new Error('Fake wss socket ERROR'));

    // Retrieve captures logs and stop capturing.
    const {capturedMessages} = consoleStream;
    consoleStream.stopCapturing();

    assert.ok(capturedMessages.some(
      (message) => (
        message.match('[debug]') &&
        message.match('Fake wss socket ERROR')
      )));

    const waitForReloadAll = new Promise((resolve) =>
      wsClient.on('message', resolve));
    await runnerInstance.reloadAllExtensions();
    assert.deepEqual(JSON.parse(await waitForReloadAll),
                     {type: 'webExtReloadAllExtensions'});

    // TODO(rpl): change this once we improve the manager extension to be able
    // to reload a single extension.
    const waitForReloadOne = new Promise((resolve) =>
      wsClient.on('message', resolve));
    await runnerInstance.reloadExtensionBySourceDir('/fake/sourceDir');
    assert.deepEqual(JSON.parse(await waitForReloadOne),
                     {type: 'webExtReloadAllExtensions'});

    // Verify that if one websocket connection gets closed, a second websocket
    // connection still receives the control messages.
    const wsClient2 = new WebSocket(wsURL);
    await new Promise((resolve) => wsClient2.on('open', resolve));
    wsClient.close();

    await runnerInstance.reloadAllExtensions();
    const waitForReloadAllAgain = new Promise((resolve) =>
      wsClient2.on('message', resolve));
    await runnerInstance.reloadAllExtensions();
    assert.deepEqual(JSON.parse(await waitForReloadAllAgain),
                     {type: 'webExtReloadAllExtensions'});

    await runnerInstance.exit();
  });

  it('exits if the chrome instance is shutting down', async () => {
    const {params, fakeChromeInstance} = prepareExtensionRunnerParams();
    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    const onceExiting = new Promise((resolve) =>
      runnerInstance.registerCleanup(resolve));

    fakeChromeInstance.process.emit('close');

    await onceExiting;
  });

  it('calls all cleanup callbacks on exit', async () => {
    const {params} = prepareExtensionRunnerParams();
    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    runnerInstance.registerCleanup(function fnThrowsError() {
      throw new Error('fake cleanup exception');
    });

    const onceExiting = new Promise((resolve) =>
      runnerInstance.registerCleanup(resolve));

    await runnerInstance.exit();
    await onceExiting;
  });

  it('does not call exit if chrome instance exits while shutting down',
     async () => {
       const {params, fakeChromeInstance} = prepareExtensionRunnerParams();
       const runnerInstance = new ChromiumExtensionRunner(params);
       await runnerInstance.run();

       sinon.spy(runnerInstance, 'exit');

       const exitDone = runnerInstance.exit();
       fakeChromeInstance.process.emit('close');

       await exitDone;

       sinon.assert.calledOnce(runnerInstance.exit);
     });

  it('awaits for the async setup to complete before exiting', async () => {
    const {params} = prepareExtensionRunnerParams({
      params: {
        chromiumLaunch: sinon.spy(async () => {
          throw new Error('Fake chromiumLaunch ERROR');
        }),
      },
    });
    const runnerInstance = new ChromiumExtensionRunner(params);
    assert.equal(runnerInstance.getName(), 'Chromium');

    await assert.isRejected(
      runnerInstance.run(),
      /Fake chromiumLaunch ERROR/
    );

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
    const {capturedMessages} = consoleStream;
    consoleStream.stopCapturing();

    assert.ok(capturedMessages.some(
      (message) => (
        message.match('[debug]') &&
        message.match('ignored setup error on chromium runner shutdown') &&
        message.match('Fake chromiumLaunch ERROR')
      )));
  });

  it('does use a custom chromium binary when passed', async () => {
    const {params} = prepareExtensionRunnerParams({
      params: {chromiumBinary: '/my/custom/chrome-bin'},
    });

    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    const {reloadManagerExtension} = runnerInstance;

    sinon.assert.calledOnce(params.chromiumLaunch);
    sinon.assert.calledWithMatch(params.chromiumLaunch, {
      ignoreDefaultFlags: true,
      enableExtensions: true,
      chromePath: '/my/custom/chrome-bin',
      chromeFlags: [
        ...defaultChromeFlags,
        `--load-extension=${reloadManagerExtension},/fake/sourceDir`,
      ],
      startingUrl: undefined,
    });

    await runnerInstance.exit();
  });

  it('does pass multiple starting urls to chrome', async () => {
    const {params} = prepareExtensionRunnerParams({
      params: {startUrl: ['url1', 'url2', 'url3']},
    });

    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    const {reloadManagerExtension} = runnerInstance;

    sinon.assert.calledOnce(params.chromiumLaunch);
    sinon.assert.calledWithMatch(params.chromiumLaunch, {
      ignoreDefaultFlags: true,
      enableExtensions: true,
      chromePath: undefined,
      chromeFlags: [
        ...defaultChromeFlags,
        `--load-extension=${reloadManagerExtension},/fake/sourceDir`,
        'url2',
        'url3',
      ],
      startingUrl: 'url1',
    });

    await runnerInstance.exit();
  });

  it('does pass additional args to chrome', async () => {
    const {params} = prepareExtensionRunnerParams({
      params: {
        args: ['--arg1', 'arg2', '--arg3'],
        startUrl: ['url1', 'url2', 'url3'],
      },
    });

    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    const {reloadManagerExtension} = runnerInstance;

    sinon.assert.calledOnce(params.chromiumLaunch);
    sinon.assert.calledWithMatch(params.chromiumLaunch, {
      ignoreDefaultFlags: true,
      enableExtensions: true,
      chromePath: undefined,
      chromeFlags: [
        ...defaultChromeFlags,
        `--load-extension=${reloadManagerExtension},/fake/sourceDir`,
        '--arg1',
        'arg2',
        '--arg3',
        'url2',
        'url3',
      ],
      startingUrl: 'url1',
    });

    await runnerInstance.exit();
  });

  it('does pass a user-data-dir flag to chrome', async () => {
    const {params} = prepareExtensionRunnerParams({
      params: {
        chromiumProfile: '/fake/chrome/profile',
      },
    });

    const runnerInstance = new ChromiumExtensionRunner(params);
    await runnerInstance.run();

    const {reloadManagerExtension} = runnerInstance;

    sinon.assert.calledOnce(params.chromiumLaunch);
    sinon.assert.calledWithMatch(params.chromiumLaunch, {
      ignoreDefaultFlags: true,
      enableExtensions: true,
      chromePath: undefined,
      chromeFlags: [
        ...defaultChromeFlags,
        `--load-extension=${reloadManagerExtension},/fake/sourceDir`,
        '--user-data-dir=/fake/chrome/profile',
      ],
      startingUrl: undefined,
    });

    await runnerInstance.exit();
  });

});
