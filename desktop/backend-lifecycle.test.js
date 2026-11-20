'use strict';

// Fast, deterministic guard for Electron main-process wiring. Native behavior lives in
// native-single-instance-smoke.js and is deliberately not run as part of this suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createBackendLifecycle, MANAGED_ENV, parseLaunchMarker } = require('./backend-lifecycle');

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.end = () => { child.stdinEnded = true; };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => { child.killSignal = signal; };
  child.exitCode = null;
  child.signalCode = null;
  return child;
}

test('all candidate ports occupied safely exits before spawning backend', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const branchStart = source.indexOf('if (PORT === null)');
  const branch = source.slice(branchStart, source.indexOf('SERVER_URL = `http', branchStart));
  assert.match(branch, /failStartup\(/);
  assert.match(branch, /return;/);
});

test('spawn is owned, managed, and gives stdin a pipe', () => {
  const lifecycle = createBackendLifecycle();
  const options = lifecycle.buildSpawnOptions({ env: { PATH: 'x' }, cwd: process.cwd() });
  assert.deepEqual(options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(options.env[MANAGED_ENV], '1');
});

test('startup awaits current child launchId readiness, not an unrelated listener', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  const start = source.slice(source.indexOf('function startPythonBackend()'), source.indexOf('function createWindow()'));
  assert.match(start, /backend\.acceptMarker\(child, line\)/);
  assert.match(start, /return backend\.waitForReady\(\)/);
  assert.doesNotMatch(start, /waitForServer|api\/options/);
});

test('normal/update quit closes stdin and waits for actual child exit before quit', async () => {
  const lifecycle = createBackendLifecycle({ exitTimeoutMs: 100 });
  const child = fakeChild();
  lifecycle.attach(child, { launchId: 'owned' });
  lifecycle.acceptMarker(child, 'IA_BACKEND_READY owned');
  const stopping = lifecycle.shutdown();
  assert.equal(child.stdinEnded, true);
  assert.equal(lifecycle.getChild(), child, 'child stays captured until actual exit');
  child.emit('exit', 0, null);
  await stopping;
  assert.equal(lifecycle.getChild(), null);
});

test('source contains no port-directed stop request or process-name cleanup', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(source, /\/api\/stop|taskkill|kill_port|netstat/);
});

test('backend loopback-origin and access-log controls remain in launcher paths', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'start.py'), 'utf8');
  assert.match(source, /IA_ACCESS_LOG/);
  assert.match(source, /start_server\("0\.0\.0\.0", port\)/);
  assert.match(source, /start_server\('127\.0\.0\.1', args\.port\)/);
});

test('readiness marker must be a standalone line from the current live child', () => {
  const lifecycle = createBackendLifecycle({ readyTimeoutMs: 1000 });
  const child = fakeChild();
  lifecycle.attach(child, { launchId: 'owned' });

  assert.equal(lifecycle.acceptMarker(child, 'prefix IA_BACKEND_READY owned'), false);
  assert.equal(lifecycle.acceptMarker(child, 'IA_BACKEND_READY owned trailing'), false);
  assert.deepEqual(parseLaunchMarker('IA_BACKEND_READY owned'), { launchId: 'owned' });
  assert.equal(parseLaunchMarker('noise IA_BACKEND_READY owned'), null);
  assert.equal(parseLaunchMarker('[py] IA_BACKEND_READY owned'), null);

  child.emit('exit', 0, null);
  assert.equal(
    lifecycle.acceptMarker(child, 'IA_BACKEND_READY owned'),
    false,
    'buffered stdout after exit must not satisfy readiness',
  );
  child.emit('close', 0, null);
});

test('readiness timeout rejects without dropping the captured child', async () => {
  const lifecycle = createBackendLifecycle({ readyTimeoutMs: 10 });
  const child = fakeChild();
  lifecycle.attach(child, { launchId: 'owned' });

  await assert.rejects(lifecycle.waitForReady(), /timeout/);
  assert.equal(lifecycle.getChild(), child, 'timeout must not pretend the child is gone');

  const stopping = lifecycle.shutdown();
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  await stopping;
});

test('forceStop kills only the captured live child and waits for real close', () => {
  const lifecycle = createBackendLifecycle({ readyTimeoutMs: 1000 });
  const child = fakeChild();
  lifecycle.attach(child, { launchId: 'owned' });

  lifecycle.forceStop();

  assert.equal(child.killSignal, 'SIGKILL');
  assert.equal(lifecycle.getChild(), child, 'kill signal is not a confirmed exit');

  child.emit('exit', null, 'SIGKILL');
  child.emit('close', null, 'SIGKILL');
  assert.equal(lifecycle.getChild(), null);
});

test('forceStop does not claim success when the captured child cannot be killed', () => {
  const lifecycle = createBackendLifecycle({ readyTimeoutMs: 1000 });
  const child = fakeChild();
  child.kill = () => { throw new Error('kill failed'); };
  lifecycle.attach(child, { launchId: 'owned' });

  lifecycle.forceStop();

  assert.equal(lifecycle.getChild(), child, 'keep the captured child until exit/close arrives');
  child.emit('exit', 1, null);
  child.emit('close', 1, null);
});
