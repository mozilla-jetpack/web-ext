/* @flow */
import { createInstance as defaultLinterCreator } from 'addons-linter';

import { createLogger } from '../util/logger.js';
import { createFileFilter as defaultFileFilterCreator } from '../util/file-filter.js';
// import flow types
import type { FileFilterCreatorFn } from '../util/file-filter.js';

const log = createLogger(import.meta.url);

// Define the needed 'addons-linter' module flow types.

export type LinterOutputType = 'text' | 'json';

export type LinterCreatorParams = {|
  config: {|
    logLevel: 'debug' | 'fatal',
    stack: boolean,
    pretty?: boolean,
    warningsAsErrors?: boolean,
    metadata?: boolean,
    minManifestVersion?: number,
    maxManifestVersion?: number,
    output?: LinterOutputType,
    privileged?: boolean,
    boring?: boolean,
    selfHosted?: boolean,
    shouldScanFile: (fileName: string) => boolean,
    _: Array<string>,
  |},
  runAsBinary: boolean,
|};

export type Linter = {|
  run: () => Promise<void>,
|};

export type LinterCreatorFn = (params: LinterCreatorParams) => Linter;

// Lint command types and implementation.

export type LintCmdParams = {|
  artifactsDir?: string,
  boring?: boolean,
  firefoxPreview: Array<string>,
  ignoreFiles?: Array<string>,
  metadata?: boolean,
  output?: LinterOutputType,
  pretty?: boolean,
  privileged?: boolean,
  selfHosted?: boolean,
  sourceDir: string,
  verbose?: boolean,
  warningsAsErrors?: boolean,
|};

export type LintCmdOptions = {
  createLinter?: LinterCreatorFn,
  createFileFilter?: FileFilterCreatorFn,
  shouldExitProgram?: boolean,
};

export default function lint(
  {
    artifactsDir,
    boring,
    firefoxPreview = [],
    ignoreFiles,
    metadata,
    output,
    pretty,
    privileged,
    sourceDir,
    selfHosted,
    verbose,
    warningsAsErrors,
  }: LintCmdParams,
  {
    createLinter = defaultLinterCreator,
    createFileFilter = defaultFileFilterCreator,
    shouldExitProgram = true,
  }: LintCmdOptions = {}
): Promise<void> {
  const fileFilter = createFileFilter({ sourceDir, ignoreFiles, artifactsDir });

  const config = {
    logLevel: verbose ? 'debug' : 'fatal',
    stack: Boolean(verbose),
    pretty,
    privileged,
    warningsAsErrors,
    metadata,
    output,
    boring,
    selfHosted,
    shouldScanFile: (fileName) => fileFilter.wantFile(fileName),
    minManifestVersion: 2,
    maxManifestVersion: 2,
    // This mimics the first command line argument from yargs, which should be
    // the directory to the extension.
    _: [sourceDir],
  };

  if (firefoxPreview.includes('mv3')) {
    config.maxManifestVersion = 3;
  }

  log.debug(`Running addons-linter on ${sourceDir}`);
  const linter = createLinter({ config, runAsBinary: shouldExitProgram });
  return linter.run();
}
