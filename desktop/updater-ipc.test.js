const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createUpdateController } = require('./updater-ipc');

function makeReleaseBody(tag, assets) {
  return { status: 200, body: { tag_name: tag, name: `Release ${tag}`, published_at: '2026-01-01T00:00:00Z', assets } };
}

test('controller check reports hasUpdate when newer release exists', async () => {
  const request = async () => makeReleaseBody('v1.2.0', [{ name: 'Interview.Assistant.Setup.1.2.0.exe', size: 1, url: 'https://u/1.2.0' }]);
  const send = (channel, payload) => { events.push({ channel, payload }); };
  const events = [];
  const ctl = createUpdateController({ currentVersion: '1.1.0', downloadsDir: os.tmpdir(), apiUrl: 'https://api', checkDelayMs: 0, request });
  ctl.onEmit(send);
  await ctl.check();
  const s = ctl.serialize();
  assert.strictEqual(s.hasUpdate, true);
  assert.strictEqual(s.latest, 'v1.2.0');
  assert.strictEqual(s.asset.name, 'Interview.Assistant.Setup.1.2.0.exe');
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
  const server = require('node:http').createServer((req, res) => {
    const body = Buffer.from('installer-bytes');
    res.writeHead(200, { 'Content-Length': body.length });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const request = async () => makeReleaseBody('v1.2.0', [{ name: 'Interview.Assistant.Setup.1.2.0.exe', size: 'installer-bytes'.length, url: `http://127.0.0.1:${port}/x` }]);
    const ctl = createUpdateController({ currentVersion: '1.1.0', downloadsDir: dir, apiUrl: 'https://api', checkDelayMs: 0, request });
    await ctl.check();
    await ctl.download();
    const s = ctl.serialize();
    assert.strictEqual(s.download.status, 'done');
    assert.ok(s.download.downloadedPath);
    assert.ok(fs.existsSync(s.download.downloadedPath));
    assert.strictEqual(fs.readFileSync(s.download.downloadedPath).toString(), 'installer-bytes');
    ctl.dispose();
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('controller install refuses before download completes', async () => {
  const ctl = createUpdateController({ currentVersion: '1.1.0', downloadsDir: os.tmpdir(), apiUrl: 'https://api' });
  const r = await ctl.install();
  assert.strictEqual(r.ok, false);
  assert.ok(r.error);
  ctl.dispose();
});

async function downloadedController(launchFn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-updipc-install-'));
  const server = require('node:http').createServer((req, res) => {
    const body = Buffer.from('installer-bytes');
    res.writeHead(200, { 'Content-Length': body.length });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const ctl = createUpdateController({
    currentVersion: '1.1.0',
    downloadsDir: dir,
    apiUrl: 'https://api',
    checkDelayMs: 0,
    request: async () => makeReleaseBody('v1.2.0', [
      { name: 'Interview.Assistant.Setup.1.2.0.exe', size: 15, url: `http://127.0.0.1:${port}/setup.exe` },
    ]),
    launchFn,
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
