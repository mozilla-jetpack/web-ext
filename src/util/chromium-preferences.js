import { UsageError } from '../errors.js';

export function coerceCLICustomChromiumPreference(cliPrefs) {
  const customPrefs = {};

  for (const pref of cliPrefs) {
    const prefsAry = pref.split('=');

    if (prefsAry.length < 2) {
      throw new UsageError(
        `Incomplete custom preference: "${pref}". ` +
          'Syntax expected: "prefname=prefvalue".',
      );
    }

    const key = prefsAry[0];
    let value = prefsAry.slice(1).join('=');

    if (/[^\w_.]/.test(key)) {
      throw new UsageError(`Invalid custom preference name: ${key}`);
    }

    if (value === `${parseInt(value)}`) {
      value = parseInt(value, 10);
    } else if (value === 'true' || value === 'false') {
      value = value === 'true';
    }

    customPrefs[`${key}`] = value;
  }

  return customPrefs;
}
