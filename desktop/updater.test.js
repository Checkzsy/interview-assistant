const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseVersion,
  compareVersions,
  pickAsset,
  checkForUpdate,
  downloadFile,
  launchInstaller,
} = require('./updater');

test('parseVersion strips v prefix and splits numeric parts', () => {
  assert.deepStrictEqual(parseVersion('v1.1.0'), { parts: [1, 1, 0], prerelease: false });
  assert.deepStrictEqual(parseVersion('1.1.0'), { parts: [1, 1, 0], prerelease: false });
  assert.deepStrictEqual(parseVersion('2.0'), { parts: [2, 0], prerelease: false });
  assert.deepStrictEqual(parseVersion('1.2.3-beta'), { parts: [1, 2, 3], prerelease: true });
  assert.strictEqual(parseVersion(''), null);
  assert.strictEqual(parseVersion(null), null);
  assert.strictEqual(parseVersion(undefined), null);
});

test('compareVersions handles ordering, equality and prerelease', () => {
  assert.strictEqual(compareVersions('1.1.0', '1.1.1'), -1);
  assert.strictEqual(compareVersions('1.1.1', '1.1.0'), 1);
  assert.strictEqual(compareVersions('v1.1.0', '1.1.0'), 0);
  assert.strictEqual(compareVersions('2.0', '1.9.9'), 1);
  assert.strictEqual(compareVersions('1.0.0', '1.0'), 0);
  assert.strictEqual(compareVersions('1.1.0-beta', '1.1.0'), -1);
  assert.strictEqual(compareVersions('1.1.0', 'nonsense'), 1);
  assert.strictEqual(compareVersions(null, null), 0);
});

test('pickAsset selects portable zip or exe by kind', () => {
  const assets = [
    { name: 'Interview.Assistant.Setup.1.1.0.exe', size: 100, url: 'https://u/exe' },
    { name: 'interview-assistant-1.1.0-win64-portable.zip', size: 200, url: 'https://u/zip' },
    { name: 'notes.txt', size: 5, url: 'https://u/notes' },
  ];
  const zip = pickAsset(assets, 'portable');
  assert.strictEqual(zip.name, 'interview-assistant-1.1.0-win64-portable.zip');
  assert.strictEqual(zip.size, 200);
  const exe = pickAsset(assets, 'exe');
  assert.strictEqual(exe.name, 'Interview.Assistant.Setup.1.1.0.exe');
  assert.strictEqual(exe.size, 100);
  assert.strictEqual(pickAsset(null, 'exe'), null);
  assert.strictEqual(pickAsset([], 'exe'), null);
});

test('checkForUpdate reports update only when latest > current and asset exists', async () => {
  const request = async () => ({
    body: {
      tag_name: 'v1.1.1',
      name: 'Interview Assistant v1.1.1',
      published_at: '2026-09-24T00:00:00Z',
      assets: [{ name: 'Interview.Assistant.Setup.1.1.1.exe', size: 123, url: 'https://u/exe' }],
    },
  });
  const result = await checkForUpdate({ currentVersion: '1.1.0', request });
  assert.strictEqual(result.hasUpdate, true);
  assert.strictEqual(result.latest, 'v1.1.1');
  assert.strictEqual(result.asset.name, 'Interview.Assistant.Setup.1.1.1.exe');
  assert.strictEqual(result.asset.size, 123);
  const noUpdate = await checkForUpdate({ currentVersion: '1.2.0', request });
  assert.strictEqual(noUpdate.hasUpdate, false);
});

test('checkForUpdate has no update when release has no matching asset', async () => {
  const request = async () => ({ body: { tag_name: 'v2.0.0', assets: [] } });
  const result = await checkForUpdate({ currentVersion: '1.0.0', request });
  assert.strictEqual(result.latest, 'v2.0.0');
  assert.strictEqual(result.hasUpdate, false);
  assert.strictEqual(result.asset, null);
});

test('downloadFile writes file, reports progress and validates size', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-update-'));
  const payload = Buffer.alloc(64 * 1024, 7);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': payload.length });
    res.end(payload);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    const dest = path.join(dir, 'download.bin');
    const progress = [];
    const result = await downloadFile(`http://127.0.0.1:${port}/x`, dest, {
      onProgress: (p) => progress.push(p),
      expectedBytes: payload.length,
    });
    assert.strictEqual(result.received, payload.length);
    assert.ok(fs.existsSync(dest));
    assert.strictEqual(fs.readFileSync(dest).length, payload.length);
    assert.ok(progress.length > 0);
    assert.strictEqual(progress[progress.length - 1].received, payload.length);
    // 大小不匹配应失败并清理
    const bad = await downloadFile(`http://127.0.0.1:${port}/x`, path.join(dir, 'bad.bin'), {
      expectedBytes: payload.length + 1,
    }).catch((err) => err);
    assert.ok(bad instanceof Error);
    assert.match(bad.message, /size mismatch/);
    assert.ok(!fs.existsSync(path.join(dir, 'bad.bin')));
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('launchInstaller rejects when installer file does not exist', async () => {
  const result = await launchInstaller('C:\\does-not-exist.exe');
  assert.strictEqual(result.ok, false);
  assert.ok(result.error);
});
