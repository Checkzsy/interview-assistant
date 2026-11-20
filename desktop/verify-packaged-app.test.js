'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createPackage } = require('@electron/asar');

const VERSION = '1.2.3';
const cli = path.join(__dirname, 'verify-packaged-app.js');

async function makeArchive(t, change = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-packaged-app-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const app = path.join(dir, 'app');
  const files = {
    'package.json': JSON.stringify({
      name: 'interview-assistant-desktop', version: VERSION, main: 'bootstrap.js',
      dependencies: { 'electron-updater': '6.8.11' },
    }),
    'node_modules/electron-updater/package.json': JSON.stringify({
      name: 'electron-updater', version: '6.8.11', main: 'out/main.js',
      dependencies: { 'builder-util-runtime': '9.7.0' },
      optionalDependencies: { 'optional-not-installed': '*' },
      devDependencies: { 'dev-not-installed': '*' },
    }),
    'node_modules/electron-updater/out/main.js': 'throw new Error("SDK must not execute");',
    'node_modules/builder-util-runtime/package.json': JSON.stringify({
      name: 'builder-util-runtime', version: '9.7.0', main: 'out/index.js',
      dependencies: { debug: '^4.3.4' },
    }),
    'node_modules/builder-util-runtime/out/index.js': 'throw new Error("dependency must not execute");',
    'node_modules/builder-util-runtime/node_modules/debug/package.json': JSON.stringify({
      name: 'debug', version: '4.4.3', exports: { '.': './index.js' },
    }),
    'node_modules/builder-util-runtime/node_modules/debug/index.js': 'throw new Error("nested dependency must not execute");',
  };
  for (const file of require('./package.json').build.files.filter((file) => file.endsWith('.js'))) {
    files[file] = 'throw new Error("app must not execute");';
  }
  change(files);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(app, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  const archive = path.join(dir, 'app.asar');
  await createPackage(app, archive);
  return archive;
}

function run(archive, version = VERSION) {
  const args = [cli, '--asar', archive];
  if (version !== null) args.push('--version', version);
  return spawnSync(process.execPath, args, {
    encoding: 'utf8', cwd: __dirname,
    // A missing packaged dependency must not pass by resolving this real SDK.
    env: { ...process.env, NODE_PATH: path.join(__dirname, 'node_modules') },
  });
}

test('accepts a packaged app with nested production dependencies without executing code', async (t) => {
  const archive = await makeArchive(t);
  const result = run(archive);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Packaged app OK: 1\.2\.3/);
});

for (const { name, change, error } of [
  {
    name: 'rejects an archive version that differs from the release version',
    change: (files) => {
      const pkg = JSON.parse(files['package.json']);
      pkg.version = '1.2.2';
      files['package.json'] = JSON.stringify(pkg);
    },
    error: /version.*1\.2\.2.*1\.2\.3/i,
  },
  {
    name: 'rejects an archive whose entry point is not bootstrap.js',
    change: (files) => {
      const pkg = JSON.parse(files['package.json']);
      pkg.main = 'main.js';
      files['package.json'] = JSON.stringify(pkg);
    },
    error: /main.*bootstrap\.js/i,
  },
  {
    name: 'rejects an archive missing a required runtime helper',
    change: (files) => { delete files['runtimePaths.js']; },
    error: /runtimePaths\.js/,
  },
  {
    name: 'rejects a missing SDK even when it is installed outside the archive',
    change: (files) => {
      delete files['node_modules/electron-updater/package.json'];
      delete files['node_modules/electron-updater/out/main.js'];
    },
    error: /electron-updater/,
  },
  {
    name: 'rejects an unpinned SDK version inside the archive',
    change: (files) => {
      const pkg = JSON.parse(files['node_modules/electron-updater/package.json']);
      pkg.version = '6.8.10';
      files['node_modules/electron-updater/package.json'] = JSON.stringify(pkg);
    },
    error: /electron-updater.*6\.8\.10.*6\.8\.11/,
  },
  {
    name: 'rejects an SDK whose main file is missing',
    change: (files) => { delete files['node_modules/electron-updater/out/main.js']; },
    error: /electron-updater/,
  },
  {
    name: 'rejects a missing hoisted transitive dependency instead of using repository node_modules',
    change: (files) => {
      for (const file of Object.keys(files)) {
        if (file.startsWith('node_modules/builder-util-runtime/')) delete files[file];
      }
    },
    error: /builder-util-runtime/,
  },
  {
    name: 'rejects a missing nested transitive dependency instead of using repository node_modules',
    change: (files) => {
      delete files['node_modules/builder-util-runtime/node_modules/debug/package.json'];
      delete files['node_modules/builder-util-runtime/node_modules/debug/index.js'];
    },
    error: /debug/,
  },
]) {
  test(name, async (t) => {
    const archive = await makeArchive(t, change);
    const result = run(archive);
    assert.equal(result.status, 1);
    assert.match(result.stderr, error);
  });
}

test('requires an explicit release version', async (t) => {
  const archive = await makeArchive(t);
  const result = run(archive, null);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--version is required/);
});
