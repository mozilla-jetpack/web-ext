/* @flow */
import fs from 'mz/fs';
import path from 'path';
import {it, describe} from 'mocha';
import {assert} from 'chai';
import sinon from 'sinon';

import build, {safeFileName, FileFilter} from '../../src/cmd/build';
import {withTempDir} from '../../src/util/temp-dir';
import {fixturePath, makeSureItFails, ZipFile} from '../helpers';
import {basicManifest} from '../test-util/test.manifest';


describe('build', () => {

  it('zips a package', () => {
    let zipFile = new ZipFile();

    return withTempDir(
      (tmpDir) =>
        build({
          sourceDir: fixturePath('minimal-web-ext'),
          artifactsDir: tmpDir.path(),
        })
        .then((buildResult) => {
          assert.match(buildResult.extensionPath,
                       /minimal_extension-1\.0\.xpi$/);
          return buildResult.extensionPath;
        })
        .then((extensionPath) => zipFile.open(extensionPath))
        .then(() => zipFile.extractFilenames())
        .then((fileNames) => {
          fileNames.sort();
          assert.deepEqual(fileNames,
                           ['background-script.js', 'manifest.json']);
        })
    );
  });

  it('prepares the artifacts dir', () => withTempDir(
    (tmpDir) => {
      const artifactsDir = path.join(tmpDir.path(), 'artifacts');
      return build(
        {
          sourceDir: fixturePath('minimal-web-ext'),
          artifactsDir,
        })
        .then(() => fs.stat(artifactsDir))
        .then((stats) => {
          assert.equal(stats.isDirectory(), true);
        });
    }
  ));

  it('lets you specify a manifest', () => withTempDir(
    (tmpDir) =>
      build({
        sourceDir: fixturePath('minimal-web-ext'),
        artifactsDir: tmpDir.path(),
      }, {
        manifestData: basicManifest,
      })
      .then((buildResult) => {
        assert.match(buildResult.extensionPath,
                     /the_extension-0\.0\.1\.xpi$/);
        return buildResult.extensionPath;
      })
  ));

  it('asks FileFilter what files to include in the XPI', () => {
    let zipFile = new ZipFile();
    let fileFilter = new FileFilter({
      filesToIgnore: ['**/background-script.js'],
    });

    return withTempDir(
      (tmpDir) =>
        build({
          sourceDir: fixturePath('minimal-web-ext'),
          artifactsDir: tmpDir.path(),
        }, {fileFilter})
        .then((buildResult) => zipFile.open(buildResult.extensionPath))
        .then(() => zipFile.extractFilenames())
        .then((fileNames) => {
          assert.notInclude(fileNames, 'background-script.js');
        })
    );
  });

  it('lets you rebuild when files change', () => withTempDir(
    (tmpDir) => {
      const fileFilter = new FileFilter();
      sinon.spy(fileFilter, 'wantFile');
      const onSourceChange = sinon.spy(() => {});
      const sourceDir = fixturePath('minimal-web-ext');
      const artifactsDir = tmpDir.path();
      return build(
        {sourceDir, artifactsDir, asNeeded: true},
        {manifestData: basicManifest, onSourceChange, fileFilter})
        .then((buildResult) => {
          // Make sure we still have a build result.
          assert.match(buildResult.extensionPath, /\.xpi$/);
          return buildResult;
        })
        .then((buildResult) => {
          assert.equal(onSourceChange.called, true);
          const args = onSourceChange.firstCall.args[0];
          assert.equal(args.sourceDir, sourceDir);
          assert.equal(args.artifactsDir, artifactsDir);
          assert.typeOf(args.onChange, 'function');

          // Make sure it uses the file filter.
          assert.typeOf(args.shouldWatchFile, 'function');
          args.shouldWatchFile('/some/path');
          assert.equal(fileFilter.wantFile.called, true);

          // Remove the built extension.
          return fs.unlink(buildResult.extensionPath)
            // Execute the onChange handler to make sure it gets built
            // again. This simulates what happens when the file watcher
            // executes the callback.
            .then(() => args.onChange());
        })
        .then((buildResult) => {
          assert.match(buildResult.extensionPath, /\.xpi$/);
          return fs.stat(buildResult.extensionPath);
        })
        .then((stat) => {
          assert.equal(stat.isFile(), true);
        });
    }
  ));

  it('throws errors when rebuilding in source watcher', () => withTempDir(
    (tmpDir) => {
      var packageResult = Promise.resolve({});
      const packageCreator = sinon.spy(() => packageResult);
      const onSourceChange = sinon.spy(() => {});
      return build(
        {
          sourceDir: fixturePath('minimal-web-ext'),
          artifactsDir: tmpDir.path(),
          asNeeded: true,
        },
        {manifestData: basicManifest, onSourceChange, packageCreator})
        .then(() => {
          assert.equal(onSourceChange.called, true);
          assert.equal(packageCreator.callCount, 1);

          const {onChange} = onSourceChange.firstCall.args[0];
          packageResult = Promise.reject(new Error(
            'Simulate an error on the second call to packageCreator()'));
          // Invoke the stub packageCreator() again which should throw an error
          return onChange();
        })
        .then(makeSureItFails())
        .catch((error) => {
          assert.include(
            error.message,
            'Simulate an error on the second call to packageCreator()');
        });
    }
  ));

  describe('safeFileName', () => {

    it('makes names safe for writing to a file system', () => {
      assert.equal(safeFileName('Bob Loblaw\'s 2005 law-blog.net'),
                   'bob_loblaw_s_2005_law-blog.net');
    });

  });

  describe('FileFilter', () => {
    const defaultFilter = new FileFilter();

    it('ignores long XPI paths by default', () => {
      assert.equal(defaultFilter.wantFile('path/to/some.xpi'), false);
    });

    it('ignores short XPI paths by default', () => {
      assert.equal(defaultFilter.wantFile('some.xpi'), false);
    });

    it('ignores .git directories by default', () => {
      assert.equal(defaultFilter.wantFile('.git'), false);
    });

    it('ignores nested .git directories by default', () => {
      assert.equal(defaultFilter.wantFile('path/to/.git'), false);
    });

    it('ignores any hidden file by default', () => {
      assert.equal(defaultFilter.wantFile('.whatever'), false);
    });

    it('ignores ZPI paths by default', () => {
      assert.equal(defaultFilter.wantFile('path/to/some.zip'), false);
    });

    it('allows other files', () => {
      assert.equal(defaultFilter.wantFile('manifest.json'), true);
    });

    it('allows you to override the defaults', () => {
      const filter = new FileFilter({
        filesToIgnore: ['manifest.json'],
      });
      assert.equal(filter.wantFile('some.xpi'), true);
      assert.equal(filter.wantFile('manifest.json'), false);
    });
    
    it('ignores node_modules by default', () => {
      assert.equal(defaultFilter.wantFile('path/to/node_modules'), false);
    });

  });

});
