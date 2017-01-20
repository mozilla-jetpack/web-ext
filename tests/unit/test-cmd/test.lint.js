/* @flow */
import {it, describe} from 'mocha';
import {assert} from 'chai';
import sinon from 'sinon';

import defaultLintCommand from '../../../src/cmd/lint';
import {makeSureItFails} from '../helpers';

type setUpParams = {|
  createLinter?: Function,
  createFileFilter?: Function,
|}

describe('lint', () => {

  function setUp({createLinter, createFileFilter}: setUpParams = {}) {
    const lintResult = '<lint.run() result placeholder>';
    const runLinter = sinon.spy(() => Promise.resolve(lintResult));
    if (!createLinter) {
      createLinter = sinon.spy(() => {
        return {run: runLinter};
      });
    }
    return {
      lintResult,
      createLinter,
      runLinter,
      lint: ({...args}) => {
        // $FLOW_IGNORE: type checks skipped for testing purpose
        return defaultLintCommand(args, {createLinter, createFileFilter});
      },
    };
  }

  it('creates and runs a linter', () => {
    const {lint, createLinter, runLinter, lintResult} = setUp();
    return lint().then((actualLintResult) => {
      assert.equal(actualLintResult, lintResult);
      assert.equal(createLinter.called, true);
      assert.equal(runLinter.called, true);
    });
  });

  it('fails when the linter fails', () => {
    const createLinter = () => {
      return {
        run: () => Promise.reject(new Error('some error from the linter')),
      };
    };
    const {lint} = setUp({createLinter});
    return lint().then(makeSureItFails(), (error) => {
      assert.match(error.message, /error from the linter/);
    });
  });

  it('runs as a binary', () => {
    const {lint, createLinter} = setUp();
    return lint().then(() => {
      const args = createLinter.firstCall.args[0];
      assert.equal(args.runAsBinary, true);
    });
  });

  it('passes sourceDir to the linter', () => {
    const {lint, createLinter} = setUp();
    return lint({sourceDir: '/some/path'}).then(() => {
      const config = createLinter.firstCall.args[0].config;
      assert.equal(config._[0], '/some/path');
    });
  });

  it('passes warningsAsErrors to the linter', () => {
    const {lint, createLinter} = setUp();
    return lint({warningsAsErrors: true}).then(() => {
      const config = createLinter.firstCall.args[0].config;
      assert.equal(config.warningsAsErrors, true);
    });
  });

  it('passes warningsAsErrors undefined to the linter', () => {
    const {lint, createLinter} = setUp();
    return lint({}).then(() => {
      const config = createLinter.firstCall.args[0].config;
      assert.equal(config.warningsAsErrors, undefined);
    });
  });

  it('configures the linter when verbose', () => {
    const {lint, createLinter} = setUp();
    return lint({verbose: true}).then(() => {
      const config = createLinter.firstCall.args[0].config;
      assert.equal(config.logLevel, 'debug');
      assert.equal(config.stack, true);
    });
  });

  it('configures the linter when not verbose', () => {
    const {lint, createLinter} = setUp();
    return lint({verbose: false}).then(() => {
      const config = createLinter.firstCall.args[0].config;
      assert.equal(config.logLevel, 'fatal');
      assert.equal(config.stack, false);
    });
  });

  it('passes through linter configuration', () => {
    const {lint, createLinter} = setUp();
    return lint({
      // $FLOW_IGNORE: wrong type used for testing purpose
      pretty: 'pretty flag',
      // $FLOW_IGNORE: wrong type used for testing purpose
      metadata: 'metadata flag',
      // $FLOW_IGNORE: wrong type used for testing purpose
      output: 'output value',
      // $FLOW_IGNORE: wrong type used for testing purpose
      boring: 'boring flag',
      // $FLOW_IGNORE: wrong type used for testing purpose
      selfHosted: 'self-hosted flag',
    }).then(() => {
      const config = createLinter.firstCall.args[0].config;
      assert.equal(config.pretty, 'pretty flag');
      assert.equal(config.metadata, 'metadata flag');
      assert.equal(config.output, 'output value');
      assert.equal(config.boring, 'boring flag');
      assert.equal(config.selfHosted, 'self-hosted flag');
    });
  });

  it('ensure linter build fileFilter correctly', () => {
    const createFileFilter = sinon.spy();
    const {lint} = setUp({createFileFilter});
    const params = {
      sourceDir: '.',
      artifactsDir: 'artifacts',
      ignoreFiles: ['file1', '**/file2'],
    };
    return lint(params).then(() => {
      assert(createFileFilter.calledWithMatch(params));
    });
  });

});
