'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyBackendStartup } = require('./verify-backend-startup');

// The real gate runs on the Windows release job against the frozen backend.exe.
// Here the marker/EOF contract is checked with stand-in Node scripts so the
// logic is covered on every platform.
function fakeBackend(t, body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ia-backend-startup-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const script = path.join(dir, 'stand-in-backend.js');
  fs.writeFileSync(script, body);
  return { backendDir: dir, command: [process.execPath, script] };
}

test('reports success when the backend announces readiness and exits on stdin EOF', async (t) => {
  const backend = fakeBackend(t, `
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
setTimeout(() => console.log('IA_BACKEND_READY ' + process.env.IA_BACKEND_LAUNCH_ID), 100);
`);
  const result = await verifyBackendStartup({ ...backend, timeoutMs: 15000, graceMs: 15000 });
  assert.equal(result.launchId, `startup-gate-${process.pid}`);
});

test('fails when the backend never announces readiness', async (t) => {
  const backend = fakeBackend(t, `
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
setTimeout(() => {}, 60000);
`);
  await assert.rejects(
    verifyBackendStartup({ ...backend, timeoutMs: 1500, graceMs: 5000 }),
    /never announced readiness within 1500ms/,
  );
});

test('fails when readiness is announced with a stale launch id', async (t) => {
  const backend = fakeBackend(t, `
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
setTimeout(() => console.log('IA_BACKEND_READY some-other-launch'), 50);
`);
  await assert.rejects(
    verifyBackendStartup({ ...backend, timeoutMs: 1500, graceMs: 5000 }),
    /never announced readiness within 1500ms/,
  );
});

test('fails when the backend ignores stdin EOF instead of shutting down', async (t) => {
  const backend = fakeBackend(t, `
process.stdin.resume();
process.stdin.on('end', () => {});
setTimeout(() => console.log('IA_BACKEND_READY ' + process.env.IA_BACKEND_LAUNCH_ID), 50);
setInterval(() => {}, 1000);
`);
  await assert.rejects(
    verifyBackendStartup({ ...backend, timeoutMs: 15000, graceMs: 1500 }),
    /did not exit within 1500ms of stdin EOF/,
  );
});

// Electron only forwards the child's stdout to the readiness check, so a marker
// that the desktop shell would never see must not pass the gate.
test('ignores a readiness marker written only to stderr', async (t) => {
  const backend = fakeBackend(t, `
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));
setTimeout(() => console.error('IA_BACKEND_READY ' + process.env.IA_BACKEND_LAUNCH_ID), 50);
`);
  await assert.rejects(
    verifyBackendStartup({ ...backend, timeoutMs: 1500, graceMs: 5000 }),
    /never announced readiness within 1500ms/,
  );
});

// A backend that announces readiness and then dies is broken; a zero exit after
// that must not be credited to the stdin EOF path.
test('fails when the backend exits right after announcing readiness', async (t) => {
  const backend = fakeBackend(t, `
process.stdin.resume();
console.log('IA_BACKEND_READY ' + process.env.IA_BACKEND_LAUNCH_ID);
process.exit(0);
`);
  await assert.rejects(
    verifyBackendStartup({ ...backend, timeoutMs: 15000, settleMs: 1000, graceMs: 5000 }),
    /exited right after announcing readiness/,
  );
});
