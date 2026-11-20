'use strict';

// Explicit real-Electron startup-failure smoke. Failures happen before any
// window exists; dialog.showErrorBox is patched to record instead of blocking
// on a native modal, and every profile is an isolated temp dir.
//
// Cases: all candidate ports held (port failure) and no python on PATH (spawn
// failure). Both must show the fixed safe message and exit without a window.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const electron = path.join(__dirname, 'node_modules', 'electron', 'dist', 'electron.exe');
const BOOTSTRAP = path.join(__dirname, 'bootstrap.js');

function runCase({ name, holdPorts }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ia-native-startup-${name}-`));
  const eventsPath = path.join(root, 'events.txt');
  const emptyBin = path.join(root, 'empty-bin');
  fs.mkdirSync(emptyBin);

  const portBlock = holdPorts ? `
const ports = [18080, 9090, 18122, 9091];
const servers = [];
Promise.all(ports.map((port) => new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve());
  server.listen(port, '127.0.0.1', () => { servers.push(server); resolve(); });
}))).then(start);
` : 'start();';

  const wrapper = `
const fs = require('node:fs');
const net = require('node:net');
const { app, dialog, BrowserWindow } = require('electron');

const eventsPath = ${JSON.stringify(eventsPath)};
const record = (value) => fs.appendFileSync(eventsPath, value + '\\n');
app.setPath('userData', ${JSON.stringify(root)});
dialog.showErrorBox = (title, content) => {
  record('dialog=' + title + '|' + content.replace(/\\n/g, ' '));
};
app.on('will-quit', () => {
  record('will-quit windows=' + BrowserWindow.getAllWindows().length);
});

const start = () => {
  record('ports-held=' + (typeof servers === 'undefined' ? 0 : servers.length));
  require(${JSON.stringify(BOOTSTRAP)});
};
${portBlock}`;

  fs.writeFileSync(path.join(root, 'index.js'), wrapper);

  const env = { ...process.env, PATH: emptyBin };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.PORT;

  const child = spawn(electron, [path.join(root, 'index.js'), '--no-sandbox'], {
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  return new Promise((resolve) => {
    child.once('close', (code) => resolve({ root, eventsPath, code, output }));
  });
}

async function expectStartupFailure(options) {
  const result = await runCase(options);
  assert.equal(result.code, 0, result.output);
  const events = fs.readFileSync(result.eventsPath, 'utf8');
  assert.ok(events.includes('dialog=应用无法启动|'), `${options.name}: error box missing`);
  assert.ok(events.includes('后台服务没能正常启动'), `${options.name}: unsafe dialog text`);
  assert.ok(!events.includes('127.0.0.1'), `${options.name}: raw reason leaked into dialog`);
  assert.ok(/will-quit windows=0/.test(events), `${options.name}: expected pre-window failure`);
  process.stdout.write(`PASS real Electron startup failure (${options.name}): safe box, no window\n`);
  process.stdout.write(`Isolated fixture profile: ${result.root}\n`);
}

(async () => {
  await expectStartupFailure({ name: 'ports', holdPorts: true });
  await expectStartupFailure({ name: 'spawn', holdPorts: false });
})().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
});
