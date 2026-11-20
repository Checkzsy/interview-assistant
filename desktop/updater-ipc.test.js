const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUpdateController } = require('./updater-ipc');

const INSTALLER_BYTES = Buffer.from('installer-bytes');
const INSTALLER_DIGEST = `sha256:${crypto.createHash('sha256').update(INSTALLER_BYTES).digest('hex')}`;

function makeReleaseBody(tag, assets) {
  return { status: 200, body: { tag_name: tag, name: `Release ${tag}`, published_at: '2026-01-01T00:00:00Z', assets } };
}

function makeAsset(over = {}) {
  return { name: 'Interview.Assistant.Setup.1.2.0.exe', size: INSTALLER_BYTES.length, url: 'https://u/1.2.0', digest: INSTALLER_DIGEST, ...over };
}

function serveInstaller(bytes = INSTALLER_BYTES) {
  return require('node:http').createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': bytes.length });
    res.end(bytes);
  });
}

async function listen(server) {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return server.address().port;
}

test('controller check reports hasUpdate when newer release exists', async () => {
  const events = [];
  const request = async () => makeReleaseBody('v1.2.0', [makeAsset()]);
  const ctl = createUpdateController({ currentVersion: '1.1.0', downloadsDir: os.tmpdir(), apiUrl: 'https://api', checkDelayMs: 0, request });
  ctl.onEmit((channel, payload) => events.push({ channel, payload }));
  await ctl.check();
  const s = ctl.serialize();
  assert.strictEqual(s.hasUpdate, true);
  assert.strictEqual(s.latest, 'v1.2.0');
  assert.strictEqual(s.asset.name, 'Interview.Assistant.Setup.1.2.0.exe');
  assert.ok(s.download.targetId, 'checked target must be bound for later install');
  assert.ok(events.some((e) => e.channel === 'updater:state'));
  ctl.dispose();
});

test('controller check silently records error without throwing', async () => {
  const request = async () => { throw new Error('network down'); };
  const ctl = createUpdateController({ currentVersion: '1.1.0', downloadsDir: os.tmpdir(), apiUrl: 'https://api', checkDelayMs: 0, request });
  await ctl.check();
  const s = ctl.serialize();
  assert.strictEqual(s.hasUpdate, false);
  assert.match(s.checkError, /network down/);
  ctl.dispose();
});

test('controller download writes installer and drives status transitions', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-updipc-'));
  const server = serveInstaller();
  const port = await listen(server);
  try {
    const request = async () => makeReleaseBody('v1.2.0', [makeAsset({ url: `http://127.0.0.1:${port}/x` })]);
    const ctl = createUpdateController({ currentVersion: '1.1.0', downloadsDir: dir, apiUrl: 'https://api', checkDelayMs: 0, request });
    await ctl.check();
    await ctl.download();
    const s = ctl.serialize();
    assert.strictEqual(s.download.status, 'done');
    assert.ok(s.download.downloadedPath);
    assert.ok(fs.existsSync(s.download.downloadedPath));
    assert.strictEqual(fs.readFileSync(s.download.downloadedPath).toString(), 'installer-bytes');
    assert.strictEqual(s.download.targetVersion, 'v1.2.0');
    ctl.dispose();
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('controller refuses legacy downloads without an externally supplied digest', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-updipc-nodigest-'));
  const server = serveInstaller();
  const port = await listen(server);
  try {
    const banned = [undefined, 'md5:abc', 'sha1:abc'];
    for (const digest of banned) {
      const request = async () => makeReleaseBody('v1.2.0', [makeAsset({ digest, url: `http://127.0.0.1:${port}/x` })]);
      const ctl = createUpdateController({ currentVersion: '1.1.0', downloadsDir: dir, apiUrl: 'https://api', checkDelayMs: 0, request });
      await ctl.check();
      await ctl.download();
      const s = ctl.serialize();
      assert.strictEqual(s.download.status, 'error', `digest ${digest} must not be installable`);
      assert.match(s.download.error, /摘要|digest/);
      ctl.dispose();
    }
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('controller install refuses before download completes', async () => {
  const request = async () => makeReleaseBody('v1.2.0', [makeAsset()]);
  const ctl = createUpdateController({ currentVersion: '1.1.0', downloadsDir: os.tmpdir(), apiUrl: 'https://api', request });
  await ctl.check();
  const r = await ctl.install();
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
  ctl.dispose();
});

async function downloadedController(launchFn, over = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-updipc-install-'));
  const server = serveInstaller();
  const port = await listen(server);
  const ctl = createUpdateController({
    currentVersion: '1.1.0',
    downloadsDir: dir,
    apiUrl: 'https://api',
    checkDelayMs: 0,
    request: async () => makeReleaseBody('v1.2.0', [makeAsset({ url: `http://127.0.0.1:${port}/setup.exe` })]),
    launchFn,
    ...over,
  });
  await ctl.check();
  await ctl.download();
  return { ctl, dir, server };
}

test('controller install passes the silent flag through to the installer', async () => {
  const cases = [
    { call: () => ({ silent: false }), expected: { silent: false } },
    // 未显式传入时保持历史行为（静默就地升级）。
    { call: () => undefined, expected: { silent: true } },
  ];
  for (const { call, expected } of cases) {
    const calls = [];
    const launchFn = async (filePath, options) => {
      calls.push(options);
      return { ok: true, pid: 1 };
    };
    const { ctl, dir, server } = await downloadedController(launchFn);
    try {
      await ctl.install(call());
      assert.deepStrictEqual(calls[0], expected);
    } finally {
      ctl.dispose();
      server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('controller re-hashes the frozen digest and blocks a corrupted pending installer', async () => {
  const calls = [];
  const launchFn = async (filePath, options) => { calls.push(options); return { ok: true, pid: 1 }; };
  const { ctl, dir, server } = await downloadedController(launchFn);
  try {
    const s = ctl.serialize();
    fs.writeFileSync(s.download.downloadedPath, Buffer.from('tampered-bytes!'));
    const r = await ctl.install();
    assert.strictEqual(r.ok, false);
    assert.equal(calls.length, 0, 'corrupted installer must never launch');
    assert.strictEqual(ctl.serialize().download.status, 'error');
  } finally {
    ctl.dispose();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a new check clears a stale install error so the failed target stays actionable', async () => {
  const launchFn = async () => ({ ok: true, pid: 1 });
  const { ctl, dir, server } = await downloadedController(launchFn);
  try {
    const s = ctl.serialize();
    fs.writeFileSync(s.download.downloadedPath, Buffer.from('tampered-bytes!'));
    const r = await ctl.install();
    assert.strictEqual(r.ok, false);
    assert.ok(ctl.serialize().installError, 'failed install records an error');
    const checked = await ctl.check();
    assert.strictEqual(checked.installError, null, 'a new check clears the stale install error');
    assert.strictEqual(checked.hasUpdate, true);
    assert.notStrictEqual(checked.download.status, 'done', 'the corrupted package is no longer offered for install');
  } finally {
    ctl.dispose();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('check during download is deferred, and a changed target invalidates the old package', async () => {
  const checks = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const request = async () => {
    checks.push(Date.now());
    return makeReleaseBody(checks.length === 1 ? 'v1.2.0' : 'v1.3.0', [
      makeAsset({ name: `Interview.Assistant.Setup.${checks.length === 1 ? '1.2.0' : '1.3.0'}.exe` }),
    ]);
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-updipc-race-'));
  const ctl = createUpdateController({
    currentVersion: '1.1.0', downloadsDir: dir, apiUrl: 'https://api', request,
    downloadFn: async (_url, dest) => {
      await gate;
      fs.writeFileSync(dest, INSTALLER_BYTES);
      return { destPath: dest, received: INSTALLER_BYTES.length, total: INSTALLER_BYTES.length };
    },
  });
  try {
    await ctl.check();
    const downloading = ctl.download();
    await new Promise((r) => setTimeout(r, 10));
    await ctl.check(); // must merge, not call the API while downloading
    assert.strictEqual(checks.length, 1, 'no SDK/api check may run during download');
    release();
    await downloading;
    await new Promise((r) => setTimeout(r, 10));
    const s = ctl.serialize();
    assert.strictEqual(checks.length, 2, 'deferred check runs after download settles');
    assert.strictEqual(s.latest, 'v1.3.0');
    assert.notStrictEqual(s.download.status, 'done', 'previous package must not stay installable');
    const r = await ctl.install();
    assert.strictEqual(r.ok, false);
  } finally {
    ctl.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('same target keeps a completed download across a re-check', async () => {
  const request = async () => makeReleaseBody('v1.2.0', [makeAsset()]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-updipc-same-'));
  const ctl = createUpdateController({
    currentVersion: '1.1.0', downloadsDir: dir, apiUrl: 'https://api', request,
    downloadFn: async (_url, dest) => {
      fs.writeFileSync(dest, INSTALLER_BYTES);
      return { destPath: dest, received: INSTALLER_BYTES.length, total: INSTALLER_BYTES.length };
    },
  });
  try {
    await ctl.check();
    await ctl.download();
    const before = ctl.serialize().download;
    await ctl.check();
    const after = ctl.serialize().download;
    assert.strictEqual(after.status, 'done');
    assert.strictEqual(after.downloadedPath, before.downloadedPath);
  } finally {
    ctl.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
