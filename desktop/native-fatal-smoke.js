'use strict';

// Explicit Windows smoke; not part of the Node-only CI suites.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const electronExe = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-native-fatal-'));
const secret = 'synthetic-secret-7c89d010';
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

for (const mode of ['throw', 'reject', 'disk-failure']) {
  const dir = path.join(root, mode);
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: `ia-fatal-${mode}`, main: 'index.js' }));
  if (mode === 'disk-failure') fs.writeFileSync(path.join(dir, 'logs'), 'blocked');
  const lines = [
    "const { app, dialog } = require('electron');",
    `app.setPath('userData', ${JSON.stringify(dir)});`,
    "dialog.showErrorBox = () => process.stderr.write('RAW_DIALOG_CALLED');",
    `require(${JSON.stringify(path.join(__dirname, 'log-redact.js'))}).createConsoleRedactor({ target: console });`,
    `require(${JSON.stringify(path.join(__dirname, 'fatal-log.js'))}).installFatalHandlers({ app, userDataPath: ${JSON.stringify(dir)} });`,
    mode === 'reject'
      ? `Promise.reject(new Error('Authorization: Bearer ${secret}'));`
      : `setImmediate(() => { throw new Error('Authorization: Bearer ${secret}'); });`,
  ];
  fs.writeFileSync(path.join(dir, 'index.js'), lines.join('\n'));
  const result = spawnSync(electronExe, [dir, '--no-sandbox'], {
    env, encoding: 'utf8', windowsHide: true, timeout: 12000,
  });
  assert.equal(result.error, undefined, `${mode}: Electron must exit, not time out`);
  assert.equal(result.status, 1, `${mode}: fatal errors must exit non-zero`);
  const output = `${result.stdout}${result.stderr}`;
  assert.ok(!output.includes(secret), `${mode}: raw console must not leak a secret`);
  assert.ok(!output.includes('RAW_DIALOG_CALLED'), `${mode}: Electron default raw error dialog must stand down`);
  if (mode !== 'disk-failure') {
    const crash = fs.readFileSync(path.join(dir, 'logs', 'main-crash.log'), 'utf8');
    assert.ok(crash.includes('Authorization: Bearer ***'));
    assert.ok(!crash.includes(secret));
  }
  process.stdout.write(`PASS real Electron ${mode}: exit=1, raw secret/dialog absent\n`);
}
process.stdout.write(`Isolated fixture profile: ${root}\n`);
