'use strict';

// Explicit real Electron lock/reveal smoke using a synthetic main and owned backend.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-native-instance-'));
const electron = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'ia-native-single-instance', main: 'index.js' }));
const lines = [
  "const fs = require('node:fs');",
  "const { spawn } = require('node:child_process');",
  "const { app, BrowserWindow, globalShortcut } = require('electron');",
  `app.setPath('userData', ${JSON.stringify(root)});`,
  `const { installBootstrap, createRevealGate, setRevealTarget } = require(${JSON.stringify(path.join(__dirname, 'singleInstance.js'))});`,
  `const resultPath = ${JSON.stringify(path.join(root, 'events.txt'))};`,
  "const record = (value) => fs.appendFileSync(resultPath, value + '\\n');",
  "const gate = createRevealGate();",
  "installBootstrap({ app, gate, loadMain: () => {",
  "  record('loaded-main');",
  "  const backend = spawn(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on(\"end\", () => process.exit(0));'], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });",
  "  record('backend=' + backend.pid);",
  "  let win;",
  "  setRevealTarget(() => { if (win.isMinimized()) win.restore(); win.show(); win.focus(); record('revealed'); });",
  "  app.whenReady().then(() => {",
  "    win = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });",
  "    win.loadURL('data:text/html,<html><body>isolated single instance</body></html>');",
  "    const registered = globalShortcut.register('Control+Alt+Shift+F12', () => {});",
  "    record('shortcut=' + registered);",
  "    record('window=' + BrowserWindow.getAllWindows().length);",
  "    setTimeout(() => { win.minimize(); gate.open(); gate.requestPending(); record('gate-open'); }, 1000);",
  "  });",
  "  app.on('before-quit', () => backend.stdin.end());",
  "  setTimeout(() => { globalShortcut.unregisterAll(); app.quit(); }, 4500);",
  "} });",
];
fs.writeFileSync(path.join(root, 'index.js'), lines.join('\n'));

function launch() {
  const child = spawn(electron, [root, '--no-sandbox'], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return { child, done: new Promise((resolve) => child.once('close', (code) => resolve({ code, output }))) };
}

async function waitForFileText(text, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (fs.existsSync(path.join(root, 'events.txt')) && fs.readFileSync(path.join(root, 'events.txt'), 'utf8').includes(text)) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`missing event ${text}`);
}

(async () => {
  const primary = launch();
  try {
    await waitForFileText('loaded-main');
    const second = launch();
    const loser = await second.done;
    assert.equal(loser.code, 0);
    await waitForFileText('revealed');
    const winner = await primary.done;
    assert.equal(winner.code, 0, winner.output);
    const events = fs.readFileSync(path.join(root, 'events.txt'), 'utf8');
    assert.equal(events.split('loaded-main').length - 1, 1, 'loser must never load synthetic main');
    assert.equal(events.split('backend=').length - 1, 1, 'only winner spawns one backend');
    assert.equal(events.split('window=').length - 1, 1, 'only winner creates one window');
    assert.equal(events.split('shortcut=').length - 1, 1, 'only winner registers one shortcut group');
    assert.ok(events.includes('window=1'));
    assert.ok(events.includes('shortcut=true'));
    process.stdout.write('PASS real Electron double-launch: one main/window/backend/shortcut group, early reveal consumed\n');
    process.stdout.write(`Isolated fixture profile: ${root}\n`);
  } finally {
    if (primary.child.exitCode === null) primary.child.kill();
  }
})().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
