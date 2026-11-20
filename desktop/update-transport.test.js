'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createUpdateTransport, verifyFile, parseAssetDigest } = require('./update-transport');
const { createUpdateFixture } = require('./update-fixtures');

for (const scenario of ['differential', 'no-range', 'no-cache', 'old-map-404', 'corrupt-map', 'corrupt-baseline', 'bad-hash']) {
  test(`pinned SDK integration: ${scenario}`, async (t) => {
    const fixture = await createUpdateFixture(t);
    const { releases, updater, cacheDir, mode, requests, missing } = fixture;
    if (scenario === 'no-range') mode.ranges = false;
    if (scenario === 'no-cache') fs.rmSync(path.join(cacheDir, 'installer.exe'));
    if (scenario === 'old-map-404') {
      fs.rmSync(path.join(cacheDir, 'current.blockmap'));
      missing.add(`/${releases[0].name}.blockmap`);
    }
    if (scenario === 'corrupt-map') fs.writeFileSync(path.join(cacheDir, 'current.blockmap'), 'broken gzip');
    if (scenario === 'corrupt-baseline') fs.writeFileSync(path.join(cacheDir, 'installer.exe'), Buffer.alloc(releases[0].contents.length, 7));
    if (scenario === 'bad-hash') mode.corrupt = true;
    const transport = createUpdateTransport({ currentVersion: '1.1.0', updater, logger: fixture.logger });
    const target = await transport.check();
    assert.equal(target.hasUpdate, true);
    assert.equal(updater.autoDownload, false);
    assert.equal(updater.autoInstallOnAppQuit, false);
    assert.equal(updater.disableWebInstaller, true);
    assert.equal(requests.some((item) => item.pathname.endsWith('.exe')), false, 'check must not download');
    if (scenario === 'bad-hash') {
      await assert.rejects(transport.download(target), /checksum|digest|sha512/i);
      return;
    }
    const result = await transport.download(target);
    assert.equal(result.downloadedPath.startsWith(path.join(cacheDir, 'pending')), true);
    assert.deepEqual(fs.readFileSync(result.downloadedPath), releases[1].contents);
    await verifyFile(result.downloadedPath, target.integrity);
    assert.equal(fixture.quitHandlers.length, 0, 'SDK must never install on quit');
    const payload = requests.filter((item) => item.pathname === `/${releases[1].name}`);
    if (scenario === 'differential') {
      assert.equal(payload.length > 0, true);
      assert.equal(payload.every((item) => item.range && item.status === 206), true);
      assert.equal(payload.reduce((sum, item) => sum + item.bytes, 0) < releases[1].contents.length, true);
    } else if (scenario !== 'corrupt-map') {
      assert.equal(payload.some((item) => !item.range && item.status === 200), true, 'failed differential must download trusted full installer');
    }
    transport.dispose();
  });
}

test('SDK pending-map from an uninstalled download cannot silently corrupt a later update', async (t) => {
  const fixture = await createUpdateFixture(t);
  const transport = createUpdateTransport({ currentVersion: '1.1.0', updater: fixture.updater, logger: fixture.logger });
  await transport.download(await transport.check());
  fixture.useRelease(2);
  const target = await transport.check();
  const result = await transport.download(target);
  assert.deepEqual(fs.readFileSync(result.downloadedPath), fixture.releases[2].contents);
  assert.deepEqual(fs.readFileSync(path.join(fixture.cacheDir, 'installer.exe')), fixture.releases[0].contents, 'downloading is not installation');
});

test('legacy fallback requires a supported externally supplied digest', async (t) => {
  const fixture = await createUpdateFixture(t);
  for (const digest of [undefined, 'md5:1234', `sha256:${'a'.repeat(64)}`]) {
    let downloads = 0;
    const transport = createUpdateTransport({
      currentVersion: '1.1.0', downloadsDir: fixture.dir, updater: null,
      request: async () => ({ body: { tag_name: 'v1.2.0', assets: [{ name: 'setup.exe', url: 'https://example.invalid/setup.exe', digest }] } }),
      downloadFn: async (_url, dest) => {
        downloads += 1;
        fs.writeFileSync(dest, 'not the promised bytes');
        return { destPath: dest };
      },
    });
    const target = await transport.check();
    await assert.rejects(transport.download(target), /摘要|digest|checksum/i);
    assert.equal(downloads, digest?.startsWith('sha256:') ? 1 : 0);
  }
  assert.equal(parseAssetDigest(`sha256:${'a'.repeat(64)}`).algorithm, 'sha256');
  assert.equal(parseAssetDigest(`sha512:${'a'.repeat(128)}`).algorithm, 'sha512');
});

test('only a missing channel file falls back; corrupt metadata does not', async () => {
  const updater = new EventEmitter();
  let calls = 0;
  let failure = null;
  updater.checkForUpdates = async () => { if (failure) throw failure; return null; };
  const transport = createUpdateTransport({
    currentVersion: '1.0.0', updater,
    request: async () => { calls += 1; return { body: { tag_name: 'v1.2.0', assets: [] } }; },
  });
  await transport.check();
  failure = Object.assign(new Error('no channel'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' });
  await transport.check();
  assert.equal(calls, 2);
  for (const code of ['ERR_UPDATER_INVALID_UPDATE_INFO', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'EAI_AGAIN']) {
    failure = Object.assign(new Error(`bad ${code}`), { code });
    await assert.rejects(transport.check(), new RegExp(code));
    assert.equal(calls, 2, `${code} must not degrade to the release API`);
  }
});
