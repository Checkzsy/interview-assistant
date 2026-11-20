'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  MAX_LOG_BYTES,
  buildCrashEntry,
  cutUtf8,
  installFatalHandlers,
  writeCrashLog,
} = require('./fatal-log');

const SECRET = 'test-bearer-k8m3q1';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ia-fatal-log-'));
}

function readCrashLog(userDataPath) {
  return fs.readFileSync(path.join(userDataPath, 'logs', 'main-crash.log'), 'utf8');
}

test('buildCrashEntry redacts before writing and keeps a timeout-free stack', () => {
  const entry = buildCrashEntry({
    kind: 'uncaughtException',
    error: new Error(`Authorization: Bearer ${SECRET}`),
    now: new Date('2026-01-02T03:04:05.000Z'),
  });

  assert.match(entry, /2026-01-02T03:04:05\.000Z/);
  assert.match(entry, /uncaughtException/);
  assert.match(entry, /Error: Authorization: Bearer \*\*\*/);
  assert.match(entry, /fatal-log\.test\.js/);
  assert.ok(!entry.includes(SECRET));
});

test('buildCrashEntry handles non-Error rejections without leaking raw values', () => {
  const entry = buildCrashEntry({
    kind: 'unhandledRejection',
    error: { token: SECRET },
  });

  assert.match(entry, /unhandledRejection/);
  assert.match(entry, /token: '\*\*\*'/);
  assert.ok(!entry.includes(SECRET));
});

test('cutUtf8 truncates on a valid UTF-8 boundary', () => {
  const text = 'a中b'; // 1 + 3 + 1 bytes
  assert.equal(cutUtf8(text, 2), 'a');
  assert.equal(cutUtf8(text, 4), 'a中');
  assert.equal(cutUtf8(text, 100), text);
});

test('writeCrashLog keeps one bounded backup and caps each entry', () => {
  const userDataPath = makeTempDir();
  const logPath = path.join(userDataPath, 'logs', 'main-crash.log');

  writeCrashLog({ userDataPath, text: 'first-entry\n' });
  writeCrashLog({ userDataPath, text: 'second-entry\n' });

  assert.equal(fs.readFileSync(logPath, 'utf8'), 'first-entry\nsecond-entry\n');

  writeCrashLog({ userDataPath, text: 'x'.repeat(MAX_LOG_BYTES + 10) });
  assert.ok(fs.statSync(logPath).size <= MAX_LOG_BYTES, 'active crash log must stay bounded');
  assert.equal(fs.readFileSync(`${logPath}.1`, 'utf8'), 'first-entry\nsecond-entry\n');
});

test('fatal handler exits non-zero and never writes the secret', () => {
  const userDataPath = makeTempDir();
  const script = `
    const { installFatalHandlers } = require(${JSON.stringify(path.join(__dirname, 'fatal-log.js'))});
    const exits = [];
    installFatalHandlers({
      userDataPath: ${JSON.stringify(userDataPath)},
      app: { exit: (code) => { exits.push(code); } },
      onExit: () => { process.exitCode = exits[0] || 1; },
    });
    process.nextTick(() => { throw new Error('Authorization: Bearer ${SECRET}'); });
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });

  assert.equal(result.status, 1, 'fatal exception must exit non-zero');
  const logged = readCrashLog(userDataPath);
  assert.match(logged, /uncaughtException/);
  assert.ok(!logged.includes(SECRET), 'secret must be redacted before writing');
  assert.ok(!result.stdout.includes(SECRET) && !result.stderr.includes(SECRET));
});

test('unhandled rejection uses the same bounded non-zero crash path', () => {
  const userDataPath = makeTempDir();
  const script = `
    const { installFatalHandlers } = require(${JSON.stringify(path.join(__dirname, 'fatal-log.js'))});
    installFatalHandlers({
      userDataPath: ${JSON.stringify(userDataPath)},
      app: { exit: (code) => { process.exitCode = code; } },
    });
    Promise.reject(new Error('X-Api-Key: ${SECRET}'));
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });

  assert.equal(result.status, 1);
  const logged = readCrashLog(userDataPath);
  assert.match(logged, /unhandledRejection/);
  assert.match(logged, /X-Api-Key: \*\*\*/);
  assert.ok(!logged.includes(SECRET));
});

test('normal exit does not create a crash log', () => {
  const userDataPath = makeTempDir();
  const script = `
    const { installFatalHandlers } = require(${JSON.stringify(path.join(__dirname, 'fatal-log.js'))});
    installFatalHandlers({
      userDataPath: ${JSON.stringify(userDataPath)},
      app: { exit: (code) => { process.exitCode = code; } },
    });
    setTimeout(() => {}, 10);
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });

  assert.equal(result.status, 0);
  assert.equal(fs.existsSync(path.join(userDataPath, 'logs', 'main-crash.log')), false);
});

test('disk failure still exits non-zero without raw stack fallback', () => {
  const tempRoot = makeTempDir();
  const userDataPath = path.join(tempRoot, 'user-data');
  fs.mkdirSync(userDataPath);
  // 让 logs 这个名字成为普通文件，writeCrashLog 的 mkdir 必然失败。
  fs.writeFileSync(path.join(userDataPath, 'logs'), 'not-a-directory');
  const script = `
    const { installFatalHandlers } = require(${JSON.stringify(path.join(__dirname, 'fatal-log.js'))});
    installFatalHandlers({
      userDataPath: ${JSON.stringify(userDataPath)},
      app: { exit: (code) => { process.exitCode = code; } },
    });
    throw new Error('token=${SECRET}');
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });

  assert.equal(result.status, 1, 'write failure must still exit non-zero');
  assert.ok(!result.stdout.includes(SECRET) && !result.stderr.includes(SECRET));
  assert.ok(!`${result.stdout}${result.stderr}`.includes('token=' + SECRET));
});
