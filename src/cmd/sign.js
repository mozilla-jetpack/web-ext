import path from 'path';

import defaultBuilder from './build.js';
import { isErrorWithCode, UsageError, WebExtError } from '../errors.js';
import { prepareArtifactsDir } from '../util/artifacts.js';
import { createLogger } from '../util/logger.js';
import getValidatedManifest, { getManifestId } from '../util/manifest.js';
import {
  defaultAsyncFsReadFile,
  signAddon as defaultSubmitAddonSigner,
} from '../util/submit-addon.js';
import { withTempDir } from '../util/temp-dir.js';

const log = createLogger(import.meta.url);

export const extensionIdFile = '.web-extension-id';
export const uploadUuidFile = '.amo-upload-uuid';

// Sign command types and implementation.

export default function sign(
  {
    amoBaseUrl,
    apiKey,
    apiProxy,
    apiSecret,
    artifactsDir,
    ignoreFiles = [],
    sourceDir,
    timeout,
    approvalTimeout,
    channel,
    amoMetadata,
    uploadSourceCode,
    webextVersion,
  },
  {
    build = defaultBuilder,
    preValidatedManifest,
    submitAddon = defaultSubmitAddonSigner,
    asyncFsReadFile = defaultAsyncFsReadFile,
  } = {},
) {
  return withTempDir(async function (tmpDir) {
    await prepareArtifactsDir(artifactsDir);

    let manifestData;
    const savedIdPath = path.join(sourceDir, extensionIdFile);
    const savedUploadUuidPath = path.join(sourceDir, uploadUuidFile);

    if (preValidatedManifest) {
      manifestData = preValidatedManifest;
    } else {
      manifestData = await getValidatedManifest(sourceDir);
    }

    const [buildResult, idFromSourceDir] = await Promise.all([
      build(
        { sourceDir, ignoreFiles, artifactsDir: tmpDir.path() },
        { manifestData, showReadyMessage: false },
      ),
      getIdFromFile(savedIdPath),
    ]);

    const id = getManifestId(manifestData);
    if (idFromSourceDir && !id) {
      throw new UsageError(
        'Cannot use previously auto-generated extension ID ' +
          `${idFromSourceDir} - This extension ID must be specified in the manifest.json file. For example:

    // manifest.json
    {
        "browser_specific_settings": {
            "gecko": {
                "id": "${idFromSourceDir}"
            }
        },

    ...
    }`,
      );
    }

    if (!id) {
      // We only auto-generate add-on IDs for MV2 add-ons on AMO.
      if (manifestData.manifest_version !== 2) {
        throw new UsageError(
          'An extension ID must be specified in the manifest.json file.',
        );
      }

      log.warn(
        'No extension ID specified (it will be auto-generated the first time)',
      );
    }

    if (!channel) {
      throw new UsageError('You must specify a channel');
    }

    let metaDataJson;
    if (amoMetadata) {
      const metadataFileBuffer = await asyncFsReadFile(amoMetadata);
      try {
        metaDataJson = JSON.parse(metadataFileBuffer.toString());
      } catch (err) {
        throw new UsageError('Invalid JSON in listing metadata');
      }
    }
    const userAgentString = `web-ext/${webextVersion}`;

    const signSubmitArgs = {
      apiKey,
      apiSecret,
      apiProxy,
      id,
      xpiPath: buildResult.extensionPath,
      downloadDir: artifactsDir,
      channel,
    };

    try {
      const result = await submitAddon({
        ...signSubmitArgs,
        amoBaseUrl,
        channel,
        savedIdPath,
        savedUploadUuidPath,
        metaDataJson,
        userAgentString,
        validationCheckTimeout: timeout,
        approvalCheckTimeout:
          approvalTimeout !== undefined ? approvalTimeout : timeout,
        submissionSource: uploadSourceCode,
      });

      return result;
    } catch (clientError) {
      throw new WebExtError(clientError.message);
    }
  });
}

export async function getIdFromFile(
  filePath,
  asyncFsReadFile = defaultAsyncFsReadFile,
) {
  let content;

  try {
    content = await asyncFsReadFile(filePath);
  } catch (error) {
    if (isErrorWithCode('ENOENT', error)) {
      log.debug(`No ID file found at: ${filePath}`);
      return;
    }
    throw error;
  }

  let lines = content.toString().split('\n');
  lines = lines.filter((line) => {
    line = line.trim();
    if (line && !line.startsWith('#')) {
      return line;
    }
  });

  const id = lines[0];
  log.debug(`Found extension ID ${id} in ${filePath}`);

  if (!id) {
    throw new UsageError(`No ID found in extension ID file ${filePath}`);
  }

  return id;
}
