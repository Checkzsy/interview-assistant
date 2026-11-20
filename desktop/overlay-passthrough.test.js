'use strict';

// A6：穿透只作用于 overlay 窗口；native 调用失败必须让状态与真实窗口一致。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createOverlayPassthroughController } = require('./overlayInput');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function extractFunctionBody(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `未找到 ${marker}`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`${marker} 函数体括号不匹配`);
}

function createHarness(overrides = {}) {
  const calls = [];
  const overlay = {
    _overlayReady: true,
    isDestroyed: () => false,
    setIgnoreMouseEvents: (...args) => calls.push(['ignore', ...args]),
    destroy: () => calls.push(['destroy']),
  };
  const stateChanges = [];
  const notices = [];
  const { overlay: testOverlay, ...controllerOverrides } = overrides;
  const activeOverlay = testOverlay || overlay;
  const controller = createOverlayPassthroughController({
    getOverlayWindow: () => activeOverlay,
    isOverlayVisible: () => true,
    isRecoveryShortcutOwned: () => true,
    onChange: (enabled) => stateChanges.push(enabled),
    onUnavailable: (message) => notices.push(message),
    ...controllerOverrides,
  });
  return { calls, controller, notices, overlay: activeOverlay, stateChanges };
}

test('enables passthrough only for a visible ready overlay with an owned recovery shortcut', () => {
  for (const blocked of [
    { isOverlayVisible: () => false },
    { isRecoveryShortcutOwned: () => false },
    { overlay: { _overlayReady: false, isDestroyed: () => false, setIgnoreMouseEvents() {} } },
    { overlay: { _overlayReady: true, _overlayInputFaulted: true, isDestroyed: () => false, setIgnoreMouseEvents() {} } },
  ]) {
    const harness = createHarness(blocked);
    assert.deepEqual(harness.controller.setEnabled(true), { ok: false, enabled: false });
    assert.deepEqual(harness.calls, []);
    assert.deepEqual(harness.stateChanges, []);
  }

  const { calls, controller, stateChanges } = createHarness();
  assert.deepEqual(controller.setEnabled(true), { ok: true, enabled: true });
  assert.deepEqual(calls, [['ignore', true, { forward: true }]]);
  assert.deepEqual(stateChanges, [true]);
});

test('does not report passthrough when the native call fails', () => {
  const calls = [];
  const { controller, stateChanges } = createHarness({
    overlay: {
      _overlayReady: true,
      isDestroyed: () => false,
      setIgnoreMouseEvents(ignore) {
        calls.push(['ignore', ignore]);
        throw new Error('native failure');
      },
    },
  });
  assert.equal(controller.setEnabled(true).ok, false);
  assert.equal(controller.isEnabled(), false);
  assert.deepEqual(stateChanges, []);
  // 开启失败后尽力恢复一次非穿透状态。
  assert.deepEqual(calls, [['ignore', true], ['ignore', false]]);
});

test('destroys the overlay when native recovery fails so it is never shown still transparent', () => {
  const { calls, controller, notices, stateChanges } = createHarness({
    overlay: {
      _overlayReady: true,
      isDestroyed: () => false,
      setIgnoreMouseEvents(ignore) {
        if (!ignore) throw new Error('cannot restore input');
        calls.push(['ignore', true, { forward: true }]);
      },
      destroy() { calls.push(['destroy']); },
    },
  });
  assert.equal(controller.setEnabled(true).ok, true);
  assert.deepEqual(controller.setEnabled(false), { ok: false, enabled: false, destroyed: true });
  assert.equal(controller.isEnabled(), false);
  assert.deepEqual(stateChanges, [true, false]);
  assert.deepEqual(calls, [['ignore', true, { forward: true }], ['destroy']]);
  assert.equal(notices.length, 1);
  // 被销毁的窗口不可复用：再次 enable 也不会调用 native。
  assert.equal(controller.setEnabled(true).ok, false);
  assert.deepEqual(calls, [['ignore', true, { forward: true }], ['destroy']]);
});

test('keeps recovery state when both native recovery and destruction fail', () => {
  const { calls, controller, notices, stateChanges } = createHarness({
    overlay: {
      _overlayReady: true,
      isDestroyed: () => false,
      setIgnoreMouseEvents(ignore) {
        if (!ignore) throw new Error('cannot restore input');
        calls.push(['ignore', true, { forward: true }]);
      },
      destroy() { throw new Error('cannot destroy'); },
    },
  });
  assert.equal(controller.setEnabled(true).ok, true);
  assert.deepEqual(controller.setEnabled(false), { ok: false, enabled: true, destroyed: false });
  assert.equal(controller.isEnabled(), true);
  assert.deepEqual(stateChanges, [true]);
  assert.deepEqual(calls, [['ignore', true, { forward: true }]]);
  assert.equal(notices.length, 1);
});

test('restore on reveal is a no-op when passthrough was never enabled', () => {
  const { calls, controller } = createHarness();
  assert.deepEqual(controller.restoreBeforeReveal(), { ok: true, enabled: false });
  assert.deepEqual(calls, []);
});

test('treats an externally destroyed overlay as no longer passthrough', () => {
  let destroyed = false;
  const { controller } = createHarness({
    overlay: {
      _overlayReady: true,
      isDestroyed: () => destroyed,
      setIgnoreMouseEvents() {},
    },
  });
  assert.equal(controller.setEnabled(true).ok, true);
  destroyed = true;
  assert.deepEqual(controller.setEnabled(false), { ok: true, enabled: false });
  assert.equal(controller.isEnabled(), false);
});

test('main exposes a native tray checkbox that reflects real passthrough state', () => {
  assert.match(MAIN_SOURCE, /label: '悬浮窗鼠标穿透',\s*type: 'checkbox'/);
  assert.match(
    MAIN_SOURCE,
    /overlayPassthroughController\.setEnabled\(menuItem\.checked\);\s*syncOverlayPassthroughMenu\(\);/,
  );
  assert.match(
    MAIN_SOURCE,
    /trayPassthroughItem\.checked = enabled;\s*trayPassthroughItem\.enabled = enabled \|\| canEnable;/,
  );
});

test('reload and show transitions close passthrough before reusing the overlay', () => {
  const loadStart = MAIN_SOURCE.indexOf("webContents.on('did-start-loading'");
  const loadListeners = MAIN_SOURCE.slice(
    loadStart,
    MAIN_SOURCE.indexOf("webContents.on('did-finish-load'", loadStart),
  );
  assert.ok(loadListeners.indexOf('_overlayReady = false') !== -1);
  assert.ok(loadListeners.indexOf('setEnabled(false)') > loadListeners.indexOf('_overlayReady = false'));
  assert.match(loadListeners, /syncOverlayPassthroughMenu\(\)/);
  assert.match(
    MAIN_SOURCE,
    /webContents\.on\('render-process-gone'[\s\S]*?_overlayReady = false;[\s\S]*?syncOverlayPassthroughMenu\(\);/,
  );

  const showBody = extractFunctionBody(MAIN_SOURCE, 'function showOverlayWindow()');
  assert.match(showBody, /_overlayInputFaulted[\s\S]*?notifyDesktopToast[\s\S]*?return;/);
  assert.ok(showBody.indexOf('_overlayInputFaulted') < showBody.indexOf('showInactive'));

  const closedBody = MAIN_SOURCE.slice(
    MAIN_SOURCE.indexOf("overlayWindow.on('closed'"),
    MAIN_SOURCE.indexOf("overlayWindow.on('moved'"),
  );
  assert.match(closedBody, /shortcutRegistry\.unregister\('toggleOverlayPassthrough'\)/);
  assert.match(closedBody, /sendOverlayState\(\{ \.\.\.lastOverlayState, visible: false \}\)/);
  assert.match(closedBody, /syncFocusOverlayShortcuts\(\)/);
});

test('recovery key is released only after native passthrough is restored', () => {
  const unregisterAllBody = extractFunctionBody(MAIN_SOURCE, 'function unregisterAllManagedShortcuts()');
  assert.ok(unregisterAllBody.indexOf('setEnabled(false)') < unregisterAllBody.indexOf('unregisterAll()'));

  const willQuitBody = extractFunctionBody(MAIN_SOURCE, "app.on('will-quit'");
  assert.ok(willQuitBody.indexOf('setEnabled(false)') < willQuitBody.indexOf('unregisterAll()'));
});
