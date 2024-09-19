import path from 'path';
import fs from 'fs/promises';

import { describe, it } from 'mocha';
import git from 'git-rev-sync';
import * as sinon from 'sinon';
import { assert } from 'chai';

import { applyConfigToArgv } from '../../src/config.js';
import {
  defaultVersionGetter,
  main,
  Program,
  throwUsageErrorIfArray,
} from '../../src/program.js';
import commands from '../../src/cmd/index.js';
import { onlyInstancesOf, UsageError } from '../../src/errors.js';
import {
  createFakeProcess,
  fake,
  makeSureItFails,
  ErrorWithCode,
  moduleURLToDirname,
} from './helpers.js';
import {
  consoleStream, // instance is imported to inspect logged messages
  ConsoleStream,
} from '../../src/util/logger.js';

const { spy } = sinon;

describe('program.Program', () => {
  function execProgram(program, options = {}) {
    const fakeProcess = createFakeProcess();
    const absolutePackageDir = path.join(
      moduleURLToDirname(import.meta.url),
      '..',
      '..',
    );
    if (program.absolutePackageDir == null) {
      program.absolutePackageDir = absolutePackageDir;
    }
    return program.execute({
      getVersion: async () => 'not-a-real-version',
      checkForUpdates: spy(),
      systemProcess: fakeProcess,
      shouldExitProgram: false,
      ...options,
    });
  }

  it('executes a command callback', () => {
    const thing = spy(() => Promise.resolve());
    const program = new Program(['thing']).command(
      'thing',
      'does a thing',
      thing,
      null,
    );
    return execProgram(program).then(() => {
      sinon.assert.called(thing);
    });
  });

  it('reports unknown commands', () => {
    const program = new Program(['thing']);
    return execProgram(program)
      .then(makeSureItFails())
      .catch(
        onlyInstancesOf(UsageError, (error) => {
          assert.match(error.message, /Unknown argument: thing/);
        }),
      );
  });

  it('reports missing command', () => {
    const program = new Program([]);
    return execProgram(program)
      .then(makeSureItFails())
      .catch(
        onlyInstancesOf(UsageError, (error) => {
          assert.match(error.message, /No sub-command was specified/);
        }),
      );
  });

  it('exits 1 on a thrown error', () => {
    const fakeProcess = createFakeProcess();
    const program = new Program(['cmd']).command('cmd', 'some command', () => {
      throw new Error('this is an error from a command handler');
    });
    return execProgram(program, {
      systemProcess: fakeProcess,
      shouldExitProgram: true,
    }).then(() => {
      sinon.assert.calledOnce(fakeProcess.exit);
      sinon.assert.calledWith(fakeProcess.exit, 1);
    });
  });

  it('throws an error if sub-command is given an argument', () => {
    const program = new Program(['thing', 'nope']).command(
      'thing',
      '',
      () => {},
    );
    return execProgram(program)
      .then(makeSureItFails())
      .catch((error) => {
        assert.match(error.message, /This command does not take any arguments/);
      });
  });

  it('handles errors that have codes', () => {
    const program = new Program(['cmd']).command('cmd', 'some command', () => {
      const error = new ErrorWithCode();
      throw error;
    });
    // This is just a smoke test to make sure the error code doesn't
    // introduce an unexpected exception.
    return execProgram(program)
      .then(makeSureItFails())
      .catch((error) => {
        assert.match(error.message, /pretend this is a system error/);
      });
  });

  it('lets commands define options', () => {
    const handler = spy(() => Promise.resolve());
    const program = new Program(['cmd']).command(
      'cmd',
      'some command',
      handler,
      {
        'some-option': {
          type: 'string',
          default: 'default value',
        },
      },
    );
    return execProgram(program).then(() => {
      // This ensures that the default configuration for the option has
      // been applied.
      sinon.assert.calledWithMatch(handler, { someOption: 'default value' });
    });
  });

  it('preserves global option configuration', () => {
    const handler = spy(() => Promise.resolve());
    const program = new Program(['cmd'])
      .setGlobalOptions({
        'global-option': {
          type: 'string',
          default: 'the default',
        },
      })
      .command('cmd', 'some command', handler, {
        'some-option': {
          type: 'string',
          default: 'default value',
        },
      });
    return execProgram(program).then(() => {
      // By checking the global default, it ensures that default configuration
      // will be applied to sub commands.
      sinon.assert.calledWithMatch(handler, {
        someOption: 'default value',
        globalOption: 'the default',
      });
    });
  });

  it('reads option values from env vars in sub commands', () => {
    // Set an env var that mimics web-ext cmd --some-opt=value
    process.env.WEB_EXT_SOME_OPT = 'value';
    let valueReceived;
    const program = new Program(['cmd']).command(
      'cmd',
      'some command',
      ({ someOpt }) => {
        valueReceived = someOpt;
      },
      {
        'some-opt': {
          type: 'string',
          describe: 'example option',
        },
      },
    );
    return execProgram(program, { shouldExitProgram: true }).then(() => {
      assert.equal(valueReceived, 'value');
      delete process.env.WEB_EXT_SOME_OPT;
    });
  });

  it('configures the logger when verbose', () => {
    const logStream = fake(new ConsoleStream());

    const program = new Program(['--verbose', 'thing']);
    program.setGlobalOptions({
      verbose: {
        type: 'boolean',
      },
    });
    program.command('thing', 'does a thing', () => {});

    return execProgram(program, {
      getVersion: spy(),
      logStream,
    }).then(() => {
      sinon.assert.called(logStream.makeVerbose);
    });
  });

  it('checks the version when verbose', () => {
    const version = spy();
    const program = new Program(['--verbose', 'thing']);
    program.setGlobalOptions({
      verbose: {
        type: 'boolean',
      },
    });
    program.command('thing', 'does a thing', () => {});
    return execProgram(program, { getVersion: version }).then(() => {
      sinon.assert.calledWith(
        version,
        path.join(moduleURLToDirname(import.meta.url), '..', '..'),
      );
    });
  });

  it('does not configure the logger unless verbose', () => {
    const logStream = fake(new ConsoleStream());
    const program = new Program(['thing']).command('thing', '', () => {});
    program.setGlobalOptions({
      verbose: {
        type: 'boolean',
        demandOption: false,
      },
    });
    return execProgram(program, { logStream }).then(() => {
      sinon.assert.notCalled(logStream.makeVerbose);
    });
  });

  it('logs UsageErrors into console', () => {
    // Clear console stream from previous messages and start recording
    consoleStream.stopCapturing();
    consoleStream.flushCapturedLogs();
    consoleStream.startCapturing();

    const program = new Program(['thing']).command('thing', '', () => {
      throw new UsageError('some error');
    });
    program.setGlobalOptions({
      verbose: {
        type: 'boolean',
        demandOption: false,
      },
    });
    return execProgram(program)
      .then(makeSureItFails())
      .catch(
        onlyInstancesOf(UsageError, (error) => {
          const { capturedMessages } = consoleStream;
          // Stop recording
          consoleStream.stopCapturing();
          assert.match(error.message, /some error/);
          assert.ok(
            capturedMessages.some((message) => message.match(/some error/)),
          );
        }),
      );
  });

  it('throws an error about unknown commands', () => {
    return execProgram(new Program(['nope']))
      .then(makeSureItFails())
      .catch((error) => {
        assert.match(error.message, /Unknown argument: nope/);
      });
  });

  it('throws an error about unknown options', () => {
    return execProgram(new Program(['--nope']))
      .then(makeSureItFails())
      .catch((error) => {
        // Make sure that the option name is in the error message.
        // Be careful not to rely on any text from yargs since it's localized.
        assert.match(error.message, /nope/);
      });
  });

  it('throws an error about unknown sub-command options', () => {
    const program = new Program(['thing', '--nope']).command(
      'thing',
      '',
      () => {},
    );
    return execProgram(program)
      .then(makeSureItFails())
      .catch((error) => {
        // Make sure that the option name is in the error message.
        // Be careful not to rely on any text from yargs since it's localized.
        assert.match(error.message, /nope/);
      });
  });

  it('passes on webextVersion', () => {
    let valueReceived;
    const program = new Program(['cmd']).command(
      'cmd',
      'some command',
      ({ webextVersion }) => {
        valueReceived = webextVersion;
      },
      {},
    );

    return execProgram(program, { shouldExitProgram: true }).then(() => {
      assert.equal(valueReceived, 'not-a-real-version');
      delete process.env.WEB_EXT_SOME_OPT;
    });
  });

  it('checks for updates automatically', () => {
    const handler = spy();
    const getVersion = async () => 'some-package-version';
    const checkForUpdates = sinon.stub();
    const program = new Program(['run']).command(
      'run',
      'some command',
      handler,
    );
    return execProgram(program, {
      checkForUpdates,
      getVersion,
      globalEnv: 'production',
    }).then(() => {
      sinon.assert.calledWith(checkForUpdates, {
        version: 'some-package-version',
      });
    });
  });

  it('does not check for updates during development', () => {
    const handler = spy();
    const getVersion = async () => 'some-package-version';
    const checkForUpdates = sinon.stub();
    const program = new Program(['run']).command(
      'run',
      'some command',
      handler,
    );
    return execProgram(program, {
      checkForUpdates,
      getVersion,
      globalEnv: 'development',
    }).then(() => {
      sinon.assert.notCalled(checkForUpdates);
    });
  });

  it('does remove environment vars unsupported by the selected command', async () => {
    const handlerRun = spy();
    const handlerSpy = spy();
    const program = new Program(['run', '--another-run-option=from-cli']);
    const fakeEnv = {
      WEB_EXT_RUN_OPTION: 'from-env',
      WEB_EXT_VERBOSE: 'true',
      WEB_EXT_SIGN_OPTION: 'from-env',
      // Also include some environment vars that miss the '_' separator
      // between envPrefix and option name.
      WEB_EXTANOTHER_RUN_OPTION: 'from-env',
      WEB_EXTANOTHER_SIGN_OPTION: 'from-env',
    };
    program.setGlobalOptions({
      verbose: {
        type: 'boolean',
        demandOption: false,
        default: false,
      },
    });
    program.command('run', 'some command', handlerRun, {
      'run-option': {
        demandOption: true,
        type: 'string',
      },
      'another-run-option': {
        demandOption: true,
        default: 'from-default',
        type: 'string',
      },
    });
    program.command('sign', 'another command', handlerSpy, {
      'sign-option': {
        demandOption: true,
        default: 'from-default',
        type: 'string',
      },
      'another-sign-option': {
        demandOption: true,
        default: 'from-default',
        type: 'string',
      },
    });

    program.cleanupProcessEnvConfigs({ env: fakeEnv });
    assert.deepEqual(fakeEnv, {
      WEB_EXT_RUN_OPTION: 'from-env',
      WEB_EXTANOTHER_RUN_OPTION: 'from-env',
      WEB_EXT_VERBOSE: 'true',
    });
  });
});

describe('program.main', () => {
  function execProgram(
    argv,
    { projectRoot = '', runOptions, ...mainOptions } = {},
  ) {
    return main(projectRoot, {
      argv,
      getVersion: () => 'not-a-real-version',
      runOptions: {
        discoverConfigFiles: async () => [],
        checkForUpdates: spy(),
        shouldExitProgram: false,
        systemProcess: createFakeProcess(),
        ...runOptions,
      },
      ...mainOptions,
    });
  }

  function makeConfigLoader({ configObjects }) {
    return (fileName) => {
      const conf = configObjects[fileName];
      if (!conf) {
        throw new Error(`Config file was not mapped: ${fileName}`);
      }
      return conf;
    };
  }

  it('executes a command handler', () => {
    const fakeCommands = fake(commands, {
      build: () => Promise.resolve(),
    });
    return execProgram(['build'], { commands: fakeCommands }).then(() => {
      // This is a smoke test mainly to make sure main() configures
      // options with handlers. It does not extensively test the
      // configuration of all handlers.
      sinon.assert.called(fakeCommands.build);
    });
  });

  it('throws an error if no command is given', () => {
    const fakeCommands = fake(commands, {});
    return execProgram([], { commands: fakeCommands })
      .then(makeSureItFails())
      .catch((error) => {
        assert.match(error.message, /You must specify a command/);
      });
  });

  it('can get the program version', async () => {
    const fakeVersionGetter = sinon.spy(() => '<version>');
    const fakeCommands = fake(commands, {
      build: () => Promise.resolve(),
    });
    const projectRoot = '/pretend/project/root';
    // For some reason, executing --version like this
    // requires a command. In the real CLI, it does not.
    await execProgram(['--version', 'build'], {
      projectRoot,
      commands: fakeCommands,
      getVersion: fakeVersionGetter,
    });

    sinon.assert.calledWith(fakeVersionGetter, projectRoot);
  });

  it('normalizes the artifactsDir path', () => {
    const fakeCommands = fake(commands, {
      build: () => Promise.resolve(),
    });
    return execProgram(
      // Add a double slash to the path, which will be fixed by normalization.
      ['build', '--artifacts-dir', process.cwd() + path.sep + path.sep],
      { commands: fakeCommands },
    ).then(() => {
      sinon.assert.calledWithMatch(fakeCommands.build, {
        artifactsDir: process.cwd() + path.sep,
      });
    });
  });

  it('passes the path of a firefox binary when specified', () => {
    const fakeCommands = fake(commands, {
      run: () => Promise.resolve(),
    });
    return execProgram(['run', '--firefox-binary', '/path/to/firefox-binary'], {
      commands: fakeCommands,
    }).then(() => {
      sinon.assert.calledWithMatch(fakeCommands.run, {
        firefox: '/path/to/firefox-binary',
      });
    });
  });

  it('passes the url of a firefox binary when specified', async () => {
    const fakeCommands = fake(commands, {
      run: () => Promise.resolve(),
    });
    const opts = { commands: fakeCommands };

    await execProgram(['run', '--start-url', 'www.example.com'], opts);
    sinon.assert.calledWithMatch(fakeCommands.run, {
      startUrl: ['www.example.com'],
    });

    // Repeat test with multiple urls.
    await execProgram(
      ['run', '--start-url', 'www.example.com', 'www.example2.com'],
      opts,
    );
    sinon.assert.calledWithMatch(fakeCommands.run, {
      startUrl: ['www.example.com', 'www.example2.com'],
    });

    await assert.isRejected(
      execProgram(['run', '--start-url'], opts),
      /Not enough arguments following: start-url/,
    );
  });

  it('opens browser console when --browser-console is specified', () => {
    const fakeCommands = fake(commands, {
      run: () => Promise.resolve(),
    });
    return execProgram(['run', '--browser-console'], {
      commands: fakeCommands,
    }).then(() => {
      sinon.assert.calledWithMatch(fakeCommands.run, { browserConsole: true });
    });
  });

  it('opens devtools when --devtools is specified', () => {
    const fakeCommands = fake(commands, {
      run: () => Promise.resolve(),
    });
    return execProgram(['run', '--devtools'], { commands: fakeCommands }).then(
      () => {
        sinon.assert.calledWithMatch(fakeCommands.run, { devtools: true });
      },
    );
  });

  async function testWatchFileOption(watchFile) {
    const fakeCommands = fake(commands, {
      run: () => Promise.resolve(),
    });

    return execProgram(['run', '--watch-file', ...watchFile], {
      commands: fakeCommands,
    }).then(() => {
      sinon.assert.calledWithMatch(fakeCommands.run, { watchFile });
    });
  }

  it('calls run with a watched file', () => {
    testWatchFileOption(['path/to/fake/file.txt']);
  });

  it('calls run with multiple watched files', () => {
    testWatchFileOption(['path/to/fake/file.txt', 'path/to/fake/file2.txt']);
  });

  async function testWatchIgnoredOption(watchIgnored) {
    const fakeCommands = fake(commands, {
      run: () => Promise.resolve(),
    });

    await execProgram(['run', '--watch-ignored', ...watchIgnored], {
      commands: fakeCommands,
    });

    sinon.assert.calledWithMatch(execProgram, fakeCommands.run, {
      watchIgnored,
    });
  }

  it('calls run with a single watchIgnored pattern', () => {
    testWatchIgnoredOption(['path/to/fake/file1.txt']);
  });

  it('calls run with a multiple watchIgnored patterns', () => {
    testWatchIgnoredOption(['path/to/fake/file1.txt', 'path/to/fake/pattern*']);
  });

  it('converts custom preferences into an object', () => {
    const fakeCommands = fake(commands, {
      run: () => Promise.resolve(),
    });
    return execProgram(
      ['run', '--pref', 'prop=true', '--pref', 'prop2=value2'],
      { commands: fakeCommands },
    ).then(() => {
      const { pref } = fakeCommands.run.firstCall.args[0];
      assert.isObject(pref);
      assert.equal(pref.prop, true);
      assert.equal(pref.prop2, 'value2');
    });
  });

  it('converts custom chromium preferences into an object', () => {
    const fakeCommands = fake(commands, {
      run: () => Promise.resolve(),
    });
    return execProgram(
      [
        'run',
        '--chromium-pref',
        'prop=true',
        '--chromium-pref',
        'prop2=value2',
      ],
      { commands: fakeCommands },
    ).then(() => {
      const { chromiumPref } = fakeCommands.run.firstCall.args[0];
      assert.isObject(chromiumPref);
      assert.equal(chromiumPref.prop, true);
      assert.equal(chromiumPref.prop2, 'value2');
    });
  });

  it('passes shouldExitProgram option to commands', () => {
    const fakeCommands = fake(commands, {
      lint: () => Promise.resolve(),
    });
    return execProgram(['lint'], { commands: fakeCommands }).then(() => {
      const options = fakeCommands.lint.firstCall.args[1];
      assert.strictEqual(options.shouldExitProgram, false);
    });
  });

  it('applies options from the specified config file', async () => {
    const fakeCommands = fake(commands, {
      lint: () => Promise.resolve(),
    });
    const configObject = {
      lint: {
        selfHosted: true,
      },
    };
    // Instead of loading/parsing a real file, just return an object.
    const fakeLoadJSConfigFile = sinon.spy(() => {
      return configObject;
    });

    await execProgram(['lint', '--config', 'path/to/web-ext-config.js'], {
      commands: fakeCommands,
      runOptions: {
        loadJSConfigFile: fakeLoadJSConfigFile,
      },
    });

    const options = fakeCommands.lint.firstCall.args[0];
    // This makes sure that the config object was applied
    // to the lint command options.
    assert.equal(options.selfHosted, configObject.lint.selfHosted);
  });

  it('discovers config files', async () => {
    const fakeCommands = fake(commands, {
      lint: () => Promise.resolve(),
    });
    const configObject = {
      lint: {
        selfHosted: true,
      },
    };
    // Instead of loading/parsing a real file, just return an object.
    const fakeLoadJSConfigFile = sinon.spy(() => {
      return configObject;
    });

    const discoveredFile = 'fake/config.js';
    await execProgram(['lint'], {
      commands: fakeCommands,
      runOptions: {
        discoverConfigFiles: async () => [discoveredFile],
        loadJSConfigFile: fakeLoadJSConfigFile,
      },
    });

    const options = fakeCommands.lint.firstCall.args[0];
    // This makes sure that the config object was applied
    // to the lint command options.
    assert.equal(options.selfHosted, configObject.lint.selfHosted);

    sinon.assert.calledWith(fakeLoadJSConfigFile, discoveredFile);
  });

  it('lets you disable config discovery', async () => {
    const fakeCommands = fake(commands, {
      lint: () => Promise.resolve(),
    });

    const discoverConfigFiles = sinon.spy(() => Promise.resolve([]));
    await execProgram(['lint', '--no-config-discovery'], {
      commands: fakeCommands,
      runOptions: {
        discoverConfigFiles,
      },
    });

    sinon.assert.notCalled(discoverConfigFiles);
  });

  it('applies config files in order', async () => {
    const fakeCommands = fake(commands, {
      lint: () => Promise.resolve(),
    });

    const globalConfig = 'home/dir/.web-ext-config.js';
    const projectConfig = 'project/dir/web-ext-config.js';
    const customConfig = path.resolve('custom/web-ext-config.js');

    const loadJSConfigFile = makeConfigLoader({
      configObjects: {
        [globalConfig]: {
          noInput: true,
        },
        [projectConfig]: {
          verbose: true,
        },
        [customConfig]: {
          lint: {
            selfHosted: true,
          },
        },
      },
    });
    const fakeApplyConfigToArgv = sinon.spy(applyConfigToArgv);

    await execProgram(['lint', '--config', customConfig], {
      commands: fakeCommands,
      runOptions: {
        applyConfigToArgv: fakeApplyConfigToArgv,
        discoverConfigFiles: async () => [globalConfig, projectConfig],
        loadJSConfigFile,
      },
    });

    // Check that the config files were all applied to argv.
    const options = fakeCommands.lint.firstCall.args[0];
    assert.equal(options.noInput, true);
    assert.equal(options.verbose, true);
    assert.equal(options.selfHosted, true);

    // Make sure the config files were loaded in the right order.
    assert.include(fakeApplyConfigToArgv.firstCall.args[0], {
      configFileName: globalConfig,
    });
    assert.include(fakeApplyConfigToArgv.secondCall.args[0], {
      configFileName: projectConfig,
    });
    assert.include(fakeApplyConfigToArgv.thirdCall.args[0], {
      configFileName: customConfig,
    });
  });

  it('overwrites old config values', async () => {
    const fakeCommands = fake(commands, {
      lint: () => Promise.resolve(),
    });

    const globalConfig = path.resolve('home/dir/.web-ext-config.js');
    const customConfig = path.resolve('custom/web-ext-config.js');

    const finalSourceDir = path.resolve('final/source-dir');
    const loadJSConfigFile = makeConfigLoader({
      configObjects: {
        // This config is loaded first.
        [globalConfig]: {
          sourceDir: 'first/source-dir',
        },
        // This config is loaded next which overwrites the old value.
        [customConfig]: {
          sourceDir: finalSourceDir,
        },
      },
    });

    await execProgram(['lint', '--config', customConfig], {
      commands: fakeCommands,
      runOptions: {
        discoverConfigFiles: async () => [globalConfig],
        loadJSConfigFile,
      },
    });

    const options = fakeCommands.lint.firstCall.args[0];
    // This should equal the final configured value.
    assert.equal(options.sourceDir, finalSourceDir);
  });

  it('enables verbose more from config file', async () => {
    const logStream = fake(new ConsoleStream());
    const fakeCommands = fake(commands, {
      lint: () => Promise.resolve(),
    });

    const customConfig = path.resolve('custom/web-ext-config.js');

    const loadJSConfigFile = makeConfigLoader({
      configObjects: {
        [customConfig]: {
          verbose: true,
        },
      },
    });

    await execProgram(['lint', '--config', customConfig], {
      commands: fakeCommands,
      runOptions: {
        discoverConfigFiles: async () => [],
        loadJSConfigFile,
        logStream,
      },
    });

    sinon.assert.called(logStream.makeVerbose);
  });

  it('requires a parameter after --ignore-files', async () => {
    const fakeCommands = fake(commands);
    return execProgram(['build', '--ignore-files'], { commands: fakeCommands })
      .then(makeSureItFails())
      .catch((error) => {
        assert.match(
          error.message,
          /Not enough arguments following: ignore-files/,
        );
      });
  });

  it('supports multiple parameters after --ignore-files', async () => {
    const fakeCommands = fake(commands, {
      build: () => Promise.resolve(),
    });
    return execProgram(
      ['build', '--ignore-files', 'f1', 'f2', '-a', 'xxx', '-i', 'f4', 'f3'],
      { commands: fakeCommands },
    ).then(() => {
      const options = fakeCommands.build.firstCall.args[0];
      assert.deepEqual(options.ignoreFiles, ['f1', 'f2', 'f4', 'f3']);
      assert.equal(options.artifactsDir, 'xxx');
    });
  });

  it('does pass a custom apk component with --firefox-apk-component', async () => {
    const fakeCommands = fake(commands, {
      build: () => Promise.resolve(),
    });
    await execProgram(
      ['run', '--firefox-apk-component', 'CustomView', '-t', 'firefox-android'],
      { commands: fakeCommands },
    );
    const options = fakeCommands.run.firstCall.args[0];
    assert.equal(options.firefoxApkComponent, 'CustomView');
  });

  describe('--no-input', () => {
    const fakeCommands = fake(commands, {
      run: () => Promise.resolve(),
    });

    const testCases = [
      ['--no-input', { noInput: true }],
      ['--no-input=false', { noInput: false }],
      ['--no-input=true', { noInput: true }],
      ['--input', { noInput: false }],
      ['--input=false', { noInput: true }],
      ['--input=true', { noInput: false }],
      ['-v', { noInput: undefined }],
    ];

    for (const [cliArg, expected] of testCases) {
      it(`does parse "${cliArg}" cli argument as ${JSON.stringify(
        expected,
      )}`, async () => {
        await execProgram(['run', cliArg], { commands: fakeCommands });
        sinon.assert.calledWithMatch(fakeCommands.run, expected);
        fakeCommands.run.resetHistory();
      });
    }
  });
});

describe('program.defaultVersionGetter', () => {
  const projectRoot = path.join(
    moduleURLToDirname(import.meta.url),
    '..',
    '..',
  );

  it('returns the package version in production', () => {
    const pkgFile = path.join(projectRoot, 'package.json');
    return fs.readFile(pkgFile).then(async (pkgData) => {
      const testBuildEnv = { globalEnv: 'production' };
      assert.equal(
        await defaultVersionGetter(projectRoot, testBuildEnv),
        JSON.parse(pkgData).version,
      );
    });
  });

  it('returns git commit information in development', function () {
    return fs.access(path.join(projectRoot, '.git')).then(
      async () => {
        const commit = `${git.branch(projectRoot)}-${git.long(projectRoot)}`;
        const testBuildEnv = { globalEnv: 'development' };
        assert.equal(
          await defaultVersionGetter(projectRoot, testBuildEnv),
          commit,
        );
      },
      () => {
        this.skip();
      },
    );
  });
});

describe('program.throwUsageErrorIfArray', () => {
  const errorMessage = 'This is the expected error message';
  const innerFn = throwUsageErrorIfArray(errorMessage);

  it('throws UsageError on array', () => {
    assert.throws(() => innerFn(['foo', 'bar']), UsageError, errorMessage);
  });
});
