import os from 'os';
import path from 'path';
import fs from 'fs/promises';

import camelCase from 'camelcase';
import decamelize from 'decamelize';
import parseJSON from 'parse-json';

import fileExists from './util/file-exists.js';
import { createLogger } from './util/logger.js';
import { UsageError, WebExtError } from './errors.js';

const log = createLogger(import.meta.url);

// NOTE: this error message is used in an interpolated string (while the other two help
// messages are being logged as is).
export const WARN_LEGACY_JS_EXT = [
  'should be renamed to ".cjs" or ".mjs" file extension to ensure its format is not ambiguous.',
  'Config files with the ".js" file extension are deprecated and will not be loaded anymore',
  'in a future web-ext major version.',
].join(' ');

export const HELP_ERR_MODULE_FROM_ESM = [
  'This config file belongs to a package.json file with "type" set to "module".',
  'Change the file extension to ".cjs" or rewrite it as an ES module and use the ".mjs" file extension.',
].join(' ');

export const HELP_ERR_IMPORTEXPORT_CJS = [
  'This config file is defined as an ES module, but it belongs to either a project directory',
  'with a package.json file with "type" set to "commonjs" or one without any package.json file.',
  'Change the file extension to ".mjs" to fix the config loading error.',
].join(' ');

const ERR_IMPORT_FROM_CJS = 'Cannot use import statement outside a module';
const ERR_EXPORT_FROM_CJS = "Unexpected token 'export'";
const ERR_MODULE_FROM_ESM = 'module is not defined in ES module scope';

export function applyConfigToArgv({
  argv,
  argvFromCLI,
  configObject,
  options,
  configFileName,
}) {
  let newArgv = { ...argv };

  for (const option of Object.keys(configObject)) {
    if (camelCase(option) !== option) {
      throw new UsageError(
        `The config option "${option}" must be ` +
          `specified in camel case: "${camelCase(option)}"`,
      );
    }

    // A config option cannot be a sub-command config
    // object if it is an array.
    if (
      !Array.isArray(configObject[option]) &&
      typeof options[option] === 'object' &&
      typeof configObject[option] === 'object'
    ) {
      // Descend into the nested configuration for a sub-command.
      newArgv = applyConfigToArgv({
        argv: newArgv,
        argvFromCLI,
        configObject: configObject[option],
        options: options[option],
        configFileName,
      });
      continue;
    }

    const decamelizedOptName = decamelize(option, { separator: '-' });

    if (typeof options[decamelizedOptName] !== 'object') {
      throw new UsageError(
        `The config file at ${configFileName} specified ` +
          `an unknown option: "${option}"`,
      );
    }
    if (options[decamelizedOptName].type === undefined) {
      // This means yargs option type wasn't not defined correctly
      throw new WebExtError(`Option: ${option} was defined without a type.`);
    }

    const expectedType =
      options[decamelizedOptName].type === 'count'
        ? 'number'
        : options[decamelizedOptName].type;

    const optionType = Array.isArray(configObject[option])
      ? 'array'
      : typeof configObject[option];

    if (optionType !== expectedType) {
      throw new UsageError(
        `The config file at ${configFileName} specified ` +
          `the type of "${option}" incorrectly as "${optionType}"` +
          ` (expected type "${expectedType}")`,
      );
    }

    let defaultValue;
    if (options[decamelizedOptName]) {
      if (options[decamelizedOptName].default !== undefined) {
        defaultValue = options[decamelizedOptName].default;
      } else if (expectedType === 'boolean') {
        defaultValue = false;
      }
    }

    // This is our best effort (without patching yargs) to detect
    // if a value was set on the CLI instead of in the config.
    // It looks for a default value and if the argv value is
    // different, it assumes that the value was configured on the CLI.

    const wasValueSetOnCLI =
      typeof argvFromCLI[option] !== 'undefined' &&
      argvFromCLI[option] !== defaultValue;
    if (wasValueSetOnCLI) {
      log.debug(
        `Favoring CLI: ${option}=${argvFromCLI[option]} over ` +
          `configuration: ${option}=${configObject[option]}`,
      );
      newArgv[option] = argvFromCLI[option];
      continue;
    }

    newArgv[option] = configObject[option];

    const coerce = options[decamelizedOptName].coerce;
    if (coerce) {
      log.debug(`Calling coerce() on configured value for ${option}`);
      newArgv[option] = coerce(newArgv[option]);
    }

    newArgv[decamelizedOptName] = newArgv[option];
  }
  return newArgv;
}

export async function loadJSConfigFile(filePath) {
  const resolvedFilePath = path.resolve(filePath);
  log.debug(
    `Loading JS config file: "${filePath}" ` +
      `(resolved to "${resolvedFilePath}")`,
  );
  if (filePath.endsWith('.js')) {
    log.warn(`WARNING: config file ${filePath} ${WARN_LEGACY_JS_EXT}`);
  }
  let configObject;
  try {
    const nonce = `${Date.now()}-${Math.random()}`;
    let configModule;
    if (resolvedFilePath.endsWith('package.json')) {
      configModule = parseJSON(
        await fs.readFile(resolvedFilePath, { encoding: 'utf-8' }),
      );
    } else {
      // https://github.com/vercel/ncc/issues/935
      const _import = new Function('path', 'return import(path)');
      configModule = await _import(`file://${resolvedFilePath}?nonce=${nonce}`);
    }

    if (configModule.default) {
      const { default: configDefault, ...esmConfigMod } = configModule;
      // ES modules may expose both a default and named exports and so
      // we merge the named exports on top of what may have been set in
      // the default export.
      configObject = { ...configDefault, ...esmConfigMod };
    } else {
      configObject = { ...configModule };
    }
  } catch (error) {
    log.debug('Handling error:', error);
    let errorMessage = error.message;
    if (error.message.startsWith(ERR_MODULE_FROM_ESM)) {
      errorMessage = HELP_ERR_MODULE_FROM_ESM;
    } else if (
      [ERR_IMPORT_FROM_CJS, ERR_EXPORT_FROM_CJS].includes(error.message)
    ) {
      errorMessage = HELP_ERR_IMPORTEXPORT_CJS;
    }
    throw new UsageError(
      `Cannot read config file: ${resolvedFilePath}\n` +
        `Error: ${errorMessage}`,
    );
  }
  if (filePath.endsWith('package.json')) {
    log.debug('Looking for webExt key inside package.json file');
    configObject = configObject.webExt || {};
  }
  if (Object.keys(configObject).length === 0) {
    log.debug(
      `Config file ${resolvedFilePath} did not define any options. ` +
        'Did you set module.exports = {...}?',
    );
  }
  return configObject;
}

export async function discoverConfigFiles({ getHomeDir = os.homedir } = {}) {
  const magicConfigName = 'web-ext-config';

  // Config files will be loaded in this order.
  const possibleConfigs = [
    // Look for a magic hidden config (preceded by dot) in home dir.
    path.join(getHomeDir(), `.${magicConfigName}.mjs`),
    path.join(getHomeDir(), `.${magicConfigName}.cjs`),
    path.join(getHomeDir(), `.${magicConfigName}.js`),
    // Look for webExt key inside package.json file
    path.join(process.cwd(), 'package.json'),
    // Look for a magic config in the current working directory.
    path.join(process.cwd(), `${magicConfigName}.mjs`),
    path.join(process.cwd(), `${magicConfigName}.cjs`),
    path.join(process.cwd(), `${magicConfigName}.js`),
    // Look for a magic hidden config (preceded by dot) the current working directory.
    path.join(process.cwd(), `.${magicConfigName}.mjs`),
    path.join(process.cwd(), `.${magicConfigName}.cjs`),
    path.join(process.cwd(), `.${magicConfigName}.js`),
  ];

  const configs = await Promise.all(
    possibleConfigs.map(async (fileName) => {
      const resolvedFileName = path.resolve(fileName);
      if (await fileExists(resolvedFileName)) {
        return resolvedFileName;
      } else {
        log.debug(
          `Discovered config "${resolvedFileName}" does not ` +
            'exist or is not readable',
        );
        return undefined;
      }
    }),
  );

  const existingConfigs = [];
  configs.forEach((f) => {
    if (typeof f === 'string') {
      existingConfigs.push(f);
    }
  });
  return existingConfigs;
}
