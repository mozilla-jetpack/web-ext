/* @flow */
import path from 'path';
import {describe, it} from 'mocha';
import {assert} from 'chai';
import deepcopy from 'deepcopy';
import sinon from 'sinon';
import FirefoxProfile from 'firefox-profile';

import * as firefox from '../../src/firefox';
import {onlyInstancesOf, WebExtError} from '../../src/errors';
import fs from 'mz/fs';
import {withTempDir} from '../../src/util/temp-dir';
import {TCPConnectError, fixturePath, fake, makeSureItFails} from '../helpers';
import {basicManifest} from '../test-util/test.manifest';
import {defaultFirefoxEnv} from '../../src/firefox/';
import {RemoteFirefox} from '../../src/firefox/remote';


describe('firefox', () => {

  describe('run', () => {

    const fakeProfile = {
      path: () => '/dev/null/some-profile-path',
    };

    const fakeFirefoxProcess = {
      on: (eventName, callback) => {
        if (eventName === 'close') {
          // Immediately "emit" a close event to complete the test.
          callback();
        }
      },
      stdout: {on: () => {}},
      stderr: {on: () => {}},
    };

    function createFakeFxRunner(firefoxOverrides={}) {
      let firefox = {
        ...deepcopy(fakeFirefoxProcess),
        ...firefoxOverrides,
      };
      return sinon.spy(() => Promise.resolve({
        args: [],
        process: firefox,
      }));
    }

    function runFirefox({profile=fakeProfile, ...args}: Object = {}) {
      return firefox.run(profile, {
        fxRunner: createFakeFxRunner(),
        findRemotePort: () => Promise.resolve(6000),
        ...args,
      });
    }

    it('executes the Firefox runner with a given profile', () => {
      const runner = createFakeFxRunner();
      const profile = fakeProfile;
      return runFirefox({fxRunner: runner, profile})
        .then(() => {
          assert.equal(runner.called, true);
          assert.equal(runner.firstCall.args[0].profile,
                       profile.path());
        });
    });

    it('starts the remote debugger on a discovered port', () => {
      const port = 6001;
      const runner = createFakeFxRunner();
      const findRemotePort = sinon.spy(() => Promise.resolve(port));
      return runFirefox({fxRunner: runner, findRemotePort})
        .then(() => {
          assert.equal(runner.called, true);
          assert.equal(runner.firstCall.args[0].listen, port);
        });
    });

    it('passes binary args to Firefox', () => {
      const fxRunner = createFakeFxRunner();
      const binaryArgs = '--safe-mode';
      return runFirefox({fxRunner, binaryArgs})
        .then(() => {
          assert.equal(fxRunner.called, true);
          assert.equal(fxRunner.firstCall.args[0]['binary-args'],
                       binaryArgs);
        });
    });

    it('sets up a Firefox process environment', () => {
      let runner = createFakeFxRunner();
      // Make sure it passes through process environment variables.
      process.env._WEB_EXT_FIREFOX_ENV_TEST = 'thing';
      return runFirefox({fxRunner: runner})
        .then(() => {
          let declaredEnv = runner.firstCall.args[0].env;
          for (let key in defaultFirefoxEnv) {
            assert.equal(declaredEnv[key], defaultFirefoxEnv[key]);
          }
          assert.equal(declaredEnv._WEB_EXT_FIREFOX_ENV_TEST, 'thing');
        });
    });

    it('fails on a firefox error', () => {
      let someError = new Error('some internal firefox error');
      let runner = createFakeFxRunner({
        on: (eventName, callback) => {
          if (eventName === 'error') {
            // Immediately "emit" an error event.
            callback(someError);
          }
        },
      });

      return runFirefox({fxRunner: runner})
        .then(makeSureItFails())
        .catch((error) => {
          assert.equal(error.message, someError.message);
        });
    });

    it('passes a custom Firefox binary when specified', () => {
      let runner = createFakeFxRunner();
      let firefoxBinary = '/pretend/path/to/firefox-bin';
      return runFirefox({fxRunner: runner, firefoxBinary})
        .then(() => {
          assert.equal(runner.called, true);
          assert.equal(runner.firstCall.args[0].binary,
                       firefoxBinary);
        });
    });

    it('logs stdout and stderr without errors', () => {
      // Store a registry of handlers that we can execute directly.
      const firefoxApp = {};
      const runner = createFakeFxRunner({
        stdout: {
          on: (event, handler) => {
            firefoxApp.writeStdout = handler;
          },
        },
        stderr: {
          on: (event, handler) => {
            firefoxApp.writeStderr = handler;
          },
        },
      });

      return runFirefox({fxRunner: runner})
        .then(() => {
          // This makes sure that when each handler writes to the
          // logger they don't raise any exceptions.
          firefoxApp.writeStdout('example of stdout');
          firefoxApp.writeStderr('example of stderr');
        });
    });

  });

  describe('copyProfile', () => {

    function withBaseProfile(callback) {
      return withTempDir(
        (tmpDir) => {
          let baseProfile = new FirefoxProfile({
            destinationDirectory: tmpDir.path(),
          });
          return callback(baseProfile);
        }
      );
    }

    it('copies a profile', () => withBaseProfile(
      (baseProfile) => {
        baseProfile.setPreference('webext.customSetting', true);
        baseProfile.updatePreferences();

        return firefox.copyProfile(baseProfile.path(),
          {configureThisProfile: (profile) => Promise.resolve(profile)})
          .then((profile) => fs.readFile(profile.userPrefs))
          .then((userPrefs) => {
            assert.include(userPrefs.toString(), 'webext.customSetting');
          });
      }
    ));

    it('requires a valid profile directory', () => {
      // This stubs out the code that looks for a named
      // profile because on Travis CI there will not be a Firefox
      // user directory.
      let copyFromUserProfile = sinon.spy(
        (config, cb) => cb(new Error('simulated: could not find profile')));

      return firefox.copyProfile('/dev/null/non_existent_path',
        {
          copyFromUserProfile,
          configureThisProfile: (profile) => Promise.resolve(profile),
        })
        .then(makeSureItFails())
        .catch(onlyInstancesOf(WebExtError, (error) => {
          assert.equal(copyFromUserProfile.called, true);
          assert.match(
            error.message,
            /Could not copy Firefox profile from .*non_existent_path/);
        }));
    });

    it('can copy a profile by name', () => {
      let name = 'some-fake-firefox-profile-name';
      // Fake profile object:
      let profileToCopy = {
        defaultPreferences: {
          thing: 'value',
        },
      };
      let copyFromUserProfile = sinon.spy(
        (config, callback) => callback(null, profileToCopy));

      return firefox.copyProfile(name,
        {
          copyFromUserProfile,
          configureThisProfile: (profile) => Promise.resolve(profile),
        })
        .then((profile) => {
          assert.equal(copyFromUserProfile.called, true);
          assert.equal(copyFromUserProfile.firstCall.args[0].name, name);
          assert.equal(profile.defaultPreferences.thing,
                       profileToCopy.defaultPreferences.thing);
        });
    });

    it('configures the copied profile', () => withBaseProfile(
      (baseProfile) => {
        let app = 'fennec';
        let configureThisProfile =
          sinon.spy((profile) => Promise.resolve(profile));

        return firefox.copyProfile(baseProfile.path(),
          {configureThisProfile, app})
          .then((profile) => {
            assert.equal(configureThisProfile.called, true);
            assert.equal(configureThisProfile.firstCall.args[0], profile);
            assert.equal(configureThisProfile.firstCall.args[1].app, app);
          });
      }
    ));

  });

  describe('createProfile', () => {

    it('resolves with a profile object', () => {
      return firefox.createProfile(
        {configureThisProfile: (profile) => Promise.resolve(profile)})
        .then((profile) => {
          assert.instanceOf(profile, FirefoxProfile);
        });
    });

    it('creates a Firefox profile', () => {
      // This is a quick and paranoid sanity check that the FirefoxProfile
      // object is real and has some preferences.
      return firefox.createProfile(
        {configureThisProfile: (profile) => Promise.resolve(profile)})
        .then((profile) => {
          profile.updatePreferences();
          return fs.readFile(path.join(profile.path(), 'user.js'));
        })
        .then((prefFile) => {
          // Check for some default pref set by FirefoxProfile.
          assert.include(prefFile.toString(),
                         '"startup.homepage_welcome_url", "about:blank"');
        });
    });

    it('configures a profile', () => {
      let configureThisProfile =
        sinon.spy((profile) => Promise.resolve(profile));
      let app = 'fennec';
      return firefox.createProfile({app, configureThisProfile})
        .then((profile) => {
          assert.equal(configureThisProfile.called, true);
          assert.equal(configureThisProfile.firstCall.args[0], profile);
          assert.equal(configureThisProfile.firstCall.args[1].app, app);
        });
    });

  });

  describe('configureProfile', () => {

    function withTempProfile(callback) {
      return withTempDir((tmpDir) => {
        let profile = new FirefoxProfile({
          destinationDirectory: tmpDir.path(),
        });
        return callback(profile);
      });
    }

    it('resolves with a profile', () => withTempProfile(
      (profile) => {
        let fakePrefGetter = sinon.stub().returns({});
        return firefox.configureProfile(profile, {getPrefs: fakePrefGetter})
          .then((profile) => {
            assert.instanceOf(profile, FirefoxProfile);
          });
      }
    ));

    it('sets Firefox preferences', () => withTempProfile(
      (profile) => {
        let fakePrefGetter = sinon.stub().returns({});
        return firefox.configureProfile(profile, {getPrefs: fakePrefGetter})
          .then(() => {
            assert.equal(fakePrefGetter.firstCall.args[0], 'firefox');
          });
      }
    ));

    it('sets Fennec preferences', () => withTempProfile(
      (profile) => {
        let fakePrefGetter = sinon.stub().returns({});
        return firefox.configureProfile(
          profile, {
            getPrefs: fakePrefGetter,
            app: 'fennec',
          })
          .then(() => {
            assert.equal(fakePrefGetter.firstCall.args[0], 'fennec');
          });
      }
    ));

    it('writes new preferences', () => withTempProfile(
      (profile) => {
        // This is a quick sanity check that real preferences were
        // written to disk.
        return firefox.configureProfile(profile)
          .then((profile) => fs.readFile(path.join(profile.path(), 'user.js')))
          .then((prefFile) => {
            // Check for some pref set by configureProfile().
            assert.include(prefFile.toString(),
                           '"devtools.debugger.remote-enabled", true');
          });
      }
    ));

  });

  describe('installExtension', () => {

    function setUp(testPromise: Function) {
      return withTempDir(
        (tmpDir) => {
          let data = {
            extensionPath: fixturePath('minimal_extension-1.0.xpi'),
            profile: undefined,
            profileDir: path.join(tmpDir.path(), 'profile'),
          };
          return fs.mkdir(data.profileDir)
            .then(() => {
              data.profile = new FirefoxProfile({
                destinationDirectory: data.profileDir,
              });
            })
            .then(() => testPromise(data));
        });
    }

    function installBasicExt(data) {
      return firefox.installExtension({
        manifestData: basicManifest,
        profile: data.profile,
        extensionPath: data.extensionPath,
      });
    }

    it('installs an extension file into a profile', () => setUp(
      (data) => {
        return installBasicExt(data)
          .then(() => fs.readdir(data.profile.extensionsDir))
          .then((files) => {
            assert.deepEqual(
              files, ['basic-manifest@web-ext-test-suite.xpi']);
          });
      }
    ));

    it('can install the extension as a proxy', () => setUp(
      (data) => {
        const sourceDir = fixturePath('minimal-web-ext');
        return firefox.installExtension(
          {
            manifestData: basicManifest,
            profile: data.profile,
            extensionPath: sourceDir,
            asProxy: true,
          })
          .then(() => {
            const proxyFile = path.join(data.profile.extensionsDir,
                                        'basic-manifest@web-ext-test-suite');
            return fs.readFile(proxyFile);
          })
          .then((proxyData) => {
            // The proxy file should contain the path to the extension.
            assert.equal(proxyData.toString(), sourceDir);
          });
      }
    ));

    it('requires a directory path for proxy installs', () => setUp(
      (data) => {
        const xpiPath = fixturePath('minimal_extension-1.0.xpi');
        return firefox.installExtension(
          {
            manifestData: basicManifest,
            profile: data.profile,
            extensionPath: xpiPath,
            asProxy: true,
          })
          .then(makeSureItFails())
          .catch(onlyInstancesOf(WebExtError, (error) => {
            assert.match(error.message,
                         /must be the extension source directory/);
            assert.include(error.message, xpiPath);
          }));
      }
    ));

    it('re-uses an existing extension directory', () => setUp(
      (data) => {
        return fs.mkdir(path.join(data.profile.extensionsDir))
          .then(() => installBasicExt(data))
          .then(() => fs.stat(data.profile.extensionsDir));
      }
    ));

    it('checks for an empty extensionsDir', () => setUp(
      (data) => {
        data.profile.extensionsDir = undefined;
        return installBasicExt(data)
          .then(makeSureItFails())
          .catch(onlyInstancesOf(WebExtError, (error) => {
            assert.match(error.message, /unexpectedly empty/);
          }));
      }
    ));

  });

  describe('defaultRemotePortFinder', () => {

    function findRemotePort({...args}: Object = {}) {
      return firefox.defaultRemotePortFinder({...args});
    }

    it('resolves to an open port', () => {
      const connectToFirefox = sinon.spy(
        () => Promise.reject(new TCPConnectError()));
      return findRemotePort({connectToFirefox})
        .then((port) => {
          assert.isNumber(port);
        });
    });

    it('throws an error when the port is occupied', () => {
      // TODO: add a retry for occupied ports.
      // https://github.com/mozilla/web-ext/issues/283
      const client = fake(RemoteFirefox.prototype);
      const connectToFirefox = sinon.spy(() => Promise.resolve(client));
      return findRemotePort({connectToFirefox})
        .then(makeSureItFails())
        .catch(onlyInstancesOf(WebExtError, (error) => {
          assert.match(error.message, /Cannot listen on port/);
          assert.equal(client.disconnect.called, true);
        }));
    });

    it('re-throws unexpected connection errors', () => {
      const connectToFirefox = sinon.spy(
        () => Promise.reject(new Error('not a connection error')));
      return findRemotePort({connectToFirefox})
        .then(makeSureItFails())
        .catch((error) => {
          assert.match(error.message, /not a connection error/);
        });
    });

  });

});
