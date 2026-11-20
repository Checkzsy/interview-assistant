'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const yaml = require('js-yaml');
const { buildBlockMap } = require('app-builder-lib/out/targets/blockmap/blockmap');
const { NsisUpdater } = require('electron-updater');
const { ElectronHttpExecutor } = require('electron-updater/out/electronHttpExecutor');

// Only the socket boundary is substituted; metadata, caching, differential
// reconstruction, progress and digest validation run in the pinned SDK.
class LocalHttpExecutor extends ElectronHttpExecutor {
  createRequest(options, callback) {
    return http.request(options, callback);
  }
}

async function createUpdateFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-update-fixture-'));
  const bytes = Buffer.alloc(512 * 1024);
  let seed = 0x12345678;
  for (let i = 0; i < bytes.length; i += 1) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    bytes[i] = seed >>> 24;
  }
  const changed = Buffer.from(bytes);
  changed.fill(0xa5, 128 * 1024, 128 * 1024 + 1024);
  const next = Buffer.from(changed);
  next.fill(0x5a, 320 * 1024, 320 * 1024 + 1024);
  const releases = [];
  for (const [index, contents] of [bytes, changed, next].entries()) {
    const version = `1.${index + 1}.0`;
    const name = `Interview.Assistant.Setup.${version}.exe`;
    const file = path.join(dir, name);
    fs.writeFileSync(file, contents);
    await buildBlockMap(file, 'gzip', `${file}.blockmap`);
    const sha512 = crypto.createHash('sha512').update(contents).digest('base64');
    const info = {
      version,
      files: [{ url: name, sha512, size: contents.length }],
      path: name,
      sha512,
      releaseDate: '2026-11-20T00:00:00.000Z',
    };
    releases.push({ version, name, file, contents, sha512, info, map: fs.readFileSync(`${file}.blockmap`) });
  }
  let current = releases[1];
  const requests = [];
  const missing = new Set();
  const mode = { ranges: true, corrupt: false };
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://127.0.0.1').pathname;
    let contents;
    if (/\/latest(?:-linux|-mac)?\.yml$/.test(pathname)) contents = Buffer.from(yaml.dump(current.info));
    else {
      const release = releases.find((item) => pathname === `/${item.name}` || pathname === `/${item.name}.blockmap`);
      if (release) contents = pathname.endsWith('.blockmap') ? release.map : release.contents;
    }
    if (!contents || missing.has(pathname)) {
      requests.push({ pathname, range: req.headers.range, status: 404, bytes: 0 });
      res.writeHead(404).end();
      return;
    }
    let status = 200;
    if (req.headers.range && mode.ranges) {
      assertSingleRange(req.headers.range);
      const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
      const from = Number(start);
      const to = Number(end);
      res.setHeader('Content-Range', `bytes ${from}-${to}/${contents.length}`);
      contents = contents.subarray(from, to + 1);
      status = 206;
    }
    if (mode.corrupt && pathname.endsWith('.exe')) {
      contents = Buffer.from(contents);
      contents[0] ^= 0xff;
    }
    requests.push({ pathname, range: req.headers.range, status, bytes: contents.length });
    res.writeHead(status, { 'Content-Length': contents.length });
    res.end(contents);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const cacheDir = path.join(dir, 'fixture-updater');
  const userDataPath = path.join(dir, 'user-data');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.mkdirSync(userDataPath, { recursive: true });
  fs.copyFileSync(releases[0].file, path.join(cacheDir, 'installer.exe'));
  fs.writeFileSync(path.join(cacheDir, 'current.blockmap'), releases[0].map);
  const appUpdateConfigPath = path.join(dir, 'app-update.yml');
  fs.writeFileSync(appUpdateConfigPath, yaml.dump({
    provider: 'generic', url, updaterCacheDirName: 'fixture-updater', useMultipleRangeRequest: false,
  }));
  const quitHandlers = [];
  const app = {
    version: releases[0].version,
    name: 'fixture-app',
    isPackaged: true,
    appUpdateConfigPath,
    userDataPath,
    baseCachePath: dir,
    whenReady: async () => {},
    onQuit: (handler) => quitHandlers.push(handler),
    quit: () => { throw new Error('test must never quit the application'); },
  };
  const updater = new NsisUpdater(null, app);
  updater.httpExecutor = new LocalHttpExecutor();
  updater.setFeedURL({ provider: 'generic', url, useMultipleRangeRequest: false });
  const logs = [];
  const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map((name) => [name, (...args) => logs.push(args.join(' '))]));
  return {
    dir, cacheDir, updater, app, logger, logs, requests, missing, mode, releases, quitHandlers,
    useRelease: (index) => { current = releases[index]; },
  };
}

function assertSingleRange(range) {
  if (!/^bytes=\d+-\d+$/.test(range)) throw new Error(`unexpected multi-range request: ${range}`);
}

module.exports = { createUpdateFixture };
