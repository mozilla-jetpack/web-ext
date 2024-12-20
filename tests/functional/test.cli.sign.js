import { spawn } from 'child_process';
import path from 'path';
import { writeFileSync } from 'fs';

import { assert } from 'chai';
import { describe, it, beforeEach, afterEach } from 'mocha';

import {
  minimalAddonPath,
  fakeServerPath,
  withTempAddonDir,
  execWebExt,
  reportCommandErrors,
} from './common.js';

// Put this as "web-ext-config.js" in the current directory, and replace
// "FAKEAPIKEY" and "FAKEAPISECRET" with the actual values to enable
// "web-ext sign" without passing those values via the CLI parameters.
const GOOD_EXAMPLE_OF_WEB_EXT_CONFIG_JS = `
module.exports = {
  sign: {
    apiKey: "FAKEAPIKEY",
    apiSecret: "FAKEAPISECRET",
  },
};
`;

// Do NOT use this to specify the API key and secret. It won't work.
const BAD_EXAMPLE_OF_WEB_EXT_CONFIG_JS = `
module.exports = {
  // Bad config: those should be under the "sign" key.
  apiKey: "FAKEAPIKEY",
  apiSecret: "FAKEAPISECRET",
};
`;

describe('web-ext sign', () => {
  let fakeServerProcess;

  beforeEach(() => {
    return new Promise((resolve, reject) => {
      const newProcess = spawn(process.execPath, [fakeServerPath]);
      newProcess.stdout.on('data', resolve);
      newProcess.stderr.on('data', reject);
      fakeServerProcess = newProcess;
    });
  });

  afterEach(() => {
    if (fakeServerProcess) {
      fakeServerProcess.kill();
      fakeServerProcess = null;
    }
  });

  it('should accept: --source-dir SRCDIR --amo-base-url URL', () =>
    withTempAddonDir({ addonPath: minimalAddonPath }, (srcDir, tmpDir) => {
      const argv = [
        'sign',
        '--verbose',
        '--channel',
        'listed',
        '--only-human-readable-source-code',
        '--amo-base-url',
        'http://localhost:8989/fake/api/v5',
        '--api-key',
        'FAKEAPIKEY',
        '--api-secret',
        'FAKEAPISECRET',
        '--source-dir',
        srcDir,
      ];
      const cmd = execWebExt(argv, { cwd: tmpDir });

      return cmd.waitForExit.then(({ exitCode, stdout, stderr }) => {
        if (exitCode !== 0) {
          reportCommandErrors({
            argv,
            exitCode,
            stdout,
            stderr,
          });
        }
      });
    }));

  it('should use config file if required parameters are not in the arguments', () =>
    withTempAddonDir({ addonPath: minimalAddonPath }, (srcDir, tmpDir) => {
      writeFileSync(
        path.join(tmpDir, 'web-ext-config.js'),
        GOOD_EXAMPLE_OF_WEB_EXT_CONFIG_JS,
      );

      writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          webExt: {
            sign: {
              amoBaseUrl: 'http://localhost:8989/fake/api/v5',
              channel: 'listed',
              onlyHumanReadableSourceCode: true,
            },
            sourceDir: srcDir,
          },
        }),
      );

      const argv = ['sign', '--verbose'];
      const cmd = execWebExt(argv, { cwd: tmpDir });

      return cmd.waitForExit.then(({ exitCode, stdout, stderr }) => {
        if (exitCode !== 0) {
          reportCommandErrors({
            argv,
            exitCode,
            stdout,
            stderr,
          });
        }
      });
    }));

  it('should show an error message if the api-key is not set in the config', () =>
    withTempAddonDir({ addonPath: minimalAddonPath }, (srcDir, tmpDir) => {
      const configFilePath = path.join(tmpDir, 'web-ext-config.js');
      writeFileSync(configFilePath, BAD_EXAMPLE_OF_WEB_EXT_CONFIG_JS);
      const argv = [
        'sign',
        '--verbose',
        '--no-config-discovery',
        '-c',
        configFilePath,
      ];
      const cmd = execWebExt(argv, { cwd: tmpDir });

      return cmd.waitForExit.then(({ exitCode, stderr }) => {
        assert.notEqual(exitCode, 0);
        assert.match(
          stderr,
          /web-ext-config.js specified an unknown option: "apiKey"/,
        );
      });
    }));

  it('should show an error message if the api-key cannot be found', () =>
    withTempAddonDir({ addonPath: minimalAddonPath }, (srcDir, tmpDir) => {
      const argv = ['sign', '--verbose', '--no-config-discovery'];
      const cmd = execWebExt(argv, { cwd: tmpDir });

      return cmd.waitForExit.then(({ exitCode, stderr }) => {
        assert.notEqual(exitCode, 0);
        assert.match(stderr, /Missing required arguments: api-key, api-secret/);
      });
    }));
});
