import { assert, expect } from 'chai';
import { describe, it } from 'mocha';

import expandPrefs from '../../../src/util/expand-prefs.js';

describe('utils/expand-prefs', () => {
  it('expands dot-deliminated preferences into a deep object', () => {
    const input = {
      a: 'a',
      'b.c': 'c',
      'd.e.f': 'f',
    };
    const expected = {
      a: 'a',
      b: {
        c: 'c',
      },
      d: {
        e: {
          f: 'f',
        },
      },
    };
    const actual = expandPrefs(input);

    assert.deepEqual(actual, expected);
  });

  it("doesn't pollute the object prototype", () => {
    const call = 'overriden';
    const input = {
      'hasOwnProperty.call': call,
    };
    const expected = {
      hasOwnProperty: {
        call,
      },
    };
    const actual = expandPrefs(input);

    assert.notEqual(Object.prototype.hasOwnProperty.call, call);
    assert.deepEqual(actual, expected);
  });

  it('throws an error when setting the child property of an already set parent', () => {
    const input = {
      a: 'a',
      'a.b': 'b',
    };

    expect(() => expandPrefs(input)).to.throw(
      'Cannot set a.b because a value already exists at a',
    );
  });

  it('allows overriding a parent even if a child has already been set', () => {
    const input = {
      'a.b': 'b',
      a: 'a',
    };
    const expected = {
      a: 'a',
    };
    const actual = expandPrefs(input);

    assert.deepEqual(actual, expected);
  });
});
