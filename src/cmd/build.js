/* @flow */
import path from 'path';
import minimatch from 'minimatch';
import {createWriteStream} from 'fs';
import streamToPromise from 'stream-to-promise';

import defaultSourceWatcher from '../watcher';
import {zipDir} from '../util/zip-dir';
import getValidatedManifest, {getManifestId} from '../util/manifest';
import {prepareArtifactsDir} from '../util/artifacts';
import {createLogger} from '../util/logger';


const log = createLogger(__filename);

export function safeFileName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\.-]+/g, '_');
}


// Import flow types.

import type {OnSourceChangeFn} from '../watcher';
import type {ExtensionManifest} from '../util/manifest';


// defaultPackageCreator types and implementation.

export type ExtensionBuildResult = {
  extensionPath: string,
};

export type PackageCreatorParams = {
  manifestData?: ExtensionManifest,
  sourceDir: string,
  fileFilter: FileFilter,
  artifactsDir: string,
};

export type PackageCreatorFn =
    (params: PackageCreatorParams) => Promise<ExtensionBuildResult>;

async function defaultPackageCreator(
  {manifestData, sourceDir, fileFilter, artifactsDir}: PackageCreatorParams
): Promise<ExtensionBuildResult> {
  let id;

  if (manifestData) {
    id = getManifestId(manifestData);
    log.debug(`Using manifest id=${id || '[not specified]'}`);
  } else {
    manifestData = await getValidatedManifest(sourceDir);
  }

  let buffer = await zipDir(sourceDir, {
    filter: (...args) => fileFilter.wantFile(...args),
  });

  let packageName = safeFileName(
    `${manifestData.name}-${manifestData.version}.zip`);
  let extensionPath = path.join(artifactsDir, packageName);
  let stream = createWriteStream(extensionPath);

  stream.write(buffer, () => stream.end());

  await streamToPromise(stream);

  log.info(`Your web extension is ready: ${extensionPath}`);
  return {extensionPath};
}


// Build command types and implementation.

export type BuildCmdParams = {
  sourceDir: string,
  artifactsDir: string,
  asNeeded?: boolean,
};

export type BuildCmdOptions = {
  manifestData?: ExtensionManifest,
  fileFilter?: FileFilter,
  onSourceChange?: OnSourceChangeFn,
  packageCreator?: PackageCreatorFn,
};

export default async function build(
  {sourceDir, artifactsDir, asNeeded = false}: BuildCmdParams,
  {
    manifestData, fileFilter = new FileFilter(),
    onSourceChange = defaultSourceWatcher,
    packageCreator = defaultPackageCreator,
  }: BuildCmdOptions = {}
): Promise<ExtensionBuildResult> {
  const rebuildAsNeeded = asNeeded; // alias for `build --as-needed`
  log.info(`Building web extension from ${sourceDir}`);

  const createPackage = () => packageCreator({
    manifestData, sourceDir, fileFilter, artifactsDir,
  });

  await prepareArtifactsDir(artifactsDir);
  let result = await createPackage();

  if (rebuildAsNeeded) {
    log.info('Rebuilding when files change...');
    onSourceChange({
      sourceDir, artifactsDir,
      onChange: () => {
        return createPackage().catch((error) => {
          log.error(error.stack);
          throw error;
        });
      },
      shouldWatchFile: (...args) => fileFilter.wantFile(...args),
    });
  }

  return result;
}


// FileFilter types and implementation.

export type FileFilterOptions = {
  filesToIgnore?: Array<string>,
};

/*
 * Allows or ignores files when creating a ZIP archive.
 */
export class FileFilter {
  filesToIgnore: Array<string>;

  constructor({filesToIgnore}: FileFilterOptions = {}) {
    this.filesToIgnore = filesToIgnore || [
      '**/*.xpi',
      '**/*.zip',
      '**/.*', // any hidden file
      '**/node_modules',
    ];
  }

  /*
   * Returns true if the file is wanted for the ZIP archive.
   *
   * This is called by zipdir as wantFile(path, stat) for each
   * file in the folder that is being archived.
   */
  wantFile(path: string): boolean {
    for (const test of this.filesToIgnore) {
      if (minimatch(path, test)) {
        log.debug(`FileFilter: ignoring file ${path}`);
        return false;
      }
    }
    return true;
  }
}
