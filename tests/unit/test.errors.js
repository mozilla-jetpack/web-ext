/* @flow */
import {describe, it} from 'mocha';
import {assert} from 'chai';

import {onlyErrorsWithCode, onlyInstancesOf} from '../../src/errors';
import {makeSureItFails} from './helpers';


describe('errors', () => {

  describe('onlyInstancesOf', () => {

    it('lets you catch a certain error', () => {
      return Promise.reject(new SyntaxError('simulated error'))
        .catch(onlyInstancesOf(SyntaxError, (error) => {
          assert.instanceOf(error, SyntaxError);
        }));
    });

    it('throws instances of other errors', () => {
      return Promise.reject(new SyntaxError('simulated error'))
        .catch(onlyInstancesOf(TypeError, () => {
          throw new Error('Unexpectedly caught the wrong error');
        }))
        .then(makeSureItFails())
        .catch((error) => {
          assert.match(error.message, /simulated error/);
        });
    });

  });

  describe('onlyErrorsWithCode', () => {

    class ErrorWithCode extends Error {
      code: string;
      constructor() {
        super('pretend this is a system error');
        this.code = 'SOME_CODE';
      }
    }

    class ErrorWithErrno extends Error {
      errno: number;
      constructor() {
        super('pretend this is a system error');
        this.errno = 53;
      }
    }

    it('catches errors having a code', () => {
      return Promise.reject(new ErrorWithCode())
        .catch(onlyErrorsWithCode('SOME_CODE', (error) => {
          assert.equal(error.code, 'SOME_CODE');
        }));
    });

    it('catches errors having a error no', () => {
      return Promise.reject(new ErrorWithErrno())
        .catch(onlyErrorsWithCode(53, (error) => {
          assert.equal(error.errno, 53);
        }));
    });

    it('throws errors that do not match the code', () => {
      return Promise.reject(new SyntaxError('simulated error'))
        .catch(onlyErrorsWithCode('SOME_CODE', () => {
          throw new Error('Unexpectedly caught the wrong error');
        }))
        .then(makeSureItFails())
        .catch((error) => {
          assert.match(error.message, /simulated error/);
        });
    });

    it('catches errors having one of many codes', () => {
      return Promise.reject(new ErrorWithCode())
        .catch(onlyErrorsWithCode(['OTHER_CODE', 'SOME_CODE'], (error) => {
          assert.equal(error.code, 'SOME_CODE');
        }));
    });

    it('catches errors having one of many errno', () => {
      return Promise.reject(new ErrorWithErrno())
        .catch(onlyErrorsWithCode([34, 53], (error) => {
          assert.equal(error.errno, 53);
        }));
    });

    it('throws errors that are not in an array of codes', () => {
      return Promise.reject(new ErrorWithCode())
        .catch(onlyErrorsWithCode(['OTHER_CODE', 'ANOTHER_CODE'], () => {
          throw new Error('Unexpectedly caught the wrong error');
        }))
        .then(makeSureItFails())
        .catch((error) => {
          assert.equal(error.code, 'SOME_CODE');
        });
    });

  });

});
