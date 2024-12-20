import ExtendableError from 'es6-error';

/*
 * Base error for all custom web-ext errors.
 */
export class WebExtError extends ExtendableError {
  constructor(message) {
    super(message);
  }
}

/*
 * The class for errors that can be fixed by the developer.
 */
export class UsageError extends WebExtError {
  constructor(message) {
    super(message);
  }
}

/*
 * The manifest for the extension is invalid (or missing).
 */
export class InvalidManifest extends UsageError {
  constructor(message) {
    super(message);
  }
}

/*
 * The remote Firefox does not support temporary add-on installation.
 */
export class RemoteTempInstallNotSupported extends WebExtError {
  constructor(message) {
    super(message);
  }
}

/*
 * The errors collected when reloading all extensions at once
 * (initialized from a map of errors by extensionSourceDir string).
 */
export class MultiExtensionsReloadError extends WebExtError {
  constructor(errorsMap) {
    let errors = '';
    for (const [sourceDir, error] of errorsMap) {
      const msg = String(error);
      errors += `\nError on extension loaded from ${sourceDir}: ${msg}\n`;
    }
    const message = `Reload errors: ${errors}`;

    super(message);
    this.errorsBySourceDir = errorsMap;
  }
}

export class UnusablePortError extends WebExtError {
  constructor(message) {
    super(message);
  }
}
export class PortInUseError extends UnusablePortError {
  constructor(message = 'The requested port is in use by another process') {
    super(message);
  }
}
export class PortInvalidError extends UnusablePortError {
  constructor(message = 'The requested port cannot be used.') {
    super(message);
  }
}

/*
 * Sugar-y way to catch only instances of a certain error.
 *
 * Usage:
 *
 *  Promise.reject(SyntaxError)
 *    .catch(onlyInstancesOf(SyntaxError, (error) => {
 *      // error is guaranteed to be an instance of SyntaxError
 *    }))
 *
 * All other errors will be re-thrown.
 *
 */
export function onlyInstancesOf(predicate, errorHandler) {
  return (error) => {
    if (error instanceof predicate) {
      return errorHandler(error);
    } else {
      throw error;
    }
  };
}

/*
 * Sugar-y way to catch only errors having certain code(s).
 *
 * Usage:
 *
 *  Promise.resolve()
 *    .catch(onlyErrorsWithCode('ENOENT', (error) => {
 *      // error.code is guaranteed to be ENOENT
 *    }))
 *
 *  or:
 *
 *  Promise.resolve()
 *    .catch(onlyErrorsWithCode(['ENOENT', 'ENOTDIR'], (error) => {
 *      // ...
 *    }))
 *
 * All other errors will be re-thrown.
 *
 */
export function onlyErrorsWithCode(codeWanted, errorHandler) {
  return (error) => {
    let throwError = true;

    if (Array.isArray(codeWanted)) {
      if (
        codeWanted.indexOf(error.code) !== -1 ||
        codeWanted.indexOf(error.errno) !== -1
      ) {
        throwError = false;
      }
    } else if (error.code === codeWanted || error.errno === codeWanted) {
      throwError = false;
    }

    if (throwError) {
      throw error;
    }

    return errorHandler(error);
  };
}

export function isErrorWithCode(codeWanted, error) {
  if (Array.isArray(codeWanted) && codeWanted.indexOf(error.code) !== -1) {
    return true;
  } else if (error.code === codeWanted) {
    return true;
  }

  return false;
}
