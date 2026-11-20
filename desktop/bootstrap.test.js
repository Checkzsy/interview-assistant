'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  installBootstrap,
  createRevealGate,
  setRevealTarget,
} = require('./singleInstance');

function fakeApp({ hasLock = true, platform = 'win32' } = {}) {
  const listeners = new Map();
  const calls = { lock: 0, quit: 0, exit: [] };
  return {
    app: {
      isPackaged: false,
      requestSingleInstanceLock() {
        calls.lock += 1;
        return hasLock;
      },
      on(event, handler) {
        listeners.set(event, handler);
      },
      quit() {
        calls.quit += 1;
      },
      exit(code) {
        calls.exit.push(code);
      },
    },
    listeners,
    calls,
    platform,
  };
}

test('lock failure exits before loading the main process and installs nothing', () => {
  const { app, listeners, calls } = fakeApp({ hasLock: false });
  const loaded = [];
  const installed = [];
  const pathCalls = [];

  const result = installBootstrap({
    app,
    loadMain: () => loaded.push('main'),
    installFatal: () => installed.push('fatal'),
    userDataPath: () => { pathCalls.push('get'); return 'C:\\fake\\user-data'; },
    setPath: () => pathCalls.push('set'),
  });

  assert.deepEqual(pathCalls, [], 'lock loser must not resolve or freeze paths');

  assert.equal(result.primary, false);
  assert.equal(calls.lock, 1);
  assert.equal(calls.quit, 1, 'second instance must quit');
  assert.deepEqual(loaded, [], 'lock loser must never require main.js');
  assert.deepEqual(installed, [], 'lock loser must not install fatal handlers');
  assert.equal(listeners.has('second-instance'), false);
});

test('lock winner installs fatal handlers, registers second-instance, then loads main once', () => {
  const { app, listeners, calls } = fakeApp({ hasLock: true });
  const order = [];

  const result = installBootstrap({
    app,
    loadMain: () => order.push('main'),
    installFatal: () => order.push('fatal'),
    userDataPath: 'C:\\fake\\user-data',
    platform: 'win32',
  });

  assert.equal(result.primary, true);
  assert.equal(calls.lock, 1);
  assert.deepEqual(order, ['fatal', 'main']);
  assert.equal(listeners.has('second-instance'), true);
  assert.equal(typeof listeners.get('second-instance'), 'function');
});

test('main is loaded exactly once even if bootstrap is invoked twice on the winner', () => {
  const { app } = fakeApp({ hasLock: true });
  let loads = 0;

  installBootstrap({
    app,
    loadMain: () => { loads += 1; },
    installFatal: () => {},
    userDataPath: 'C:\\fake\\user-data',
    platform: 'win32',
  });
  installBootstrap({
    app,
    loadMain: () => { loads += 1; },
    installFatal: () => {},
    userDataPath: 'C:\\fake\\user-data',
    platform: 'win32',
  });

  assert.equal(loads, 1);
});

test('second-instance reveal requests are stashed and consumed only after the gate opens', () => {
  const gate = createRevealGate();
  const revealed = [];
  const request = () => revealed.push(true);

  assert.equal(gate.reveal(request), false, 'early reveal must be deferred');
  assert.deepEqual(revealed, []);

  gate.open();
  assert.deepEqual(revealed, [], 'opening the gate alone does not reveal');

  assert.equal(gate.reveal(request), true);
  assert.deepEqual(revealed, [true]);
});

test('a reveal requested while closed is consumed once by the next reveal after open', () => {
  const gate = createRevealGate();
  const reveals = [];
  const request = () => reveals.push(true);

  gate.reveal(request);
  gate.reveal(request);
  assert.deepEqual(reveals, []);

  gate.open();
  assert.equal(gate.requestPending(), true, 'queued request is consumed once');
  assert.equal(gate.requestPending(), false, 'a consumed request must not replay');
  assert.deepEqual(reveals, [true], 'coalesced requests produce a single reveal');
});

test('second-instance handler in bootstrap defers reveal until the main process opens the gate', () => {
  const { app, listeners } = fakeApp({ hasLock: true });
  const reveals = [];
  const gateForTest = createRevealGate();
  setRevealTarget(() => reveals.push('reveal'));

  installBootstrap({
    app,
    loadMain: () => {},
    installFatal: () => {},
    userDataPath: 'C:\\fake\\user-data',
    gate: gateForTest,
  });

  const secondInstance = listeners.get('second-instance');
  secondInstance();
  assert.deepEqual(reveals, [], 'reveal before first frame must wait');

  gateForTest.open();
  gateForTest.requestPending();
  assert.deepEqual(reveals, ['reveal'], 'queued reveal is consumed once the first frame is safe');
});

test('bootstrap freezes the userData path before the name could change', () => {
  const { app, calls } = fakeApp({ hasLock: true });
  const setPathCalls = [];

  installBootstrap({
    app,
    setPath: (name, value) => setPathCalls.push([name, value]),
    loadMain: () => {},
    installFatal: () => {},
    userDataPath: 'C:\\fake\\AppData\\Roaming\\interview-assistant-desktop',
    platform: 'win32',
  });

  assert.deepEqual(setPathCalls, [
    ['userData', 'C:\\fake\\AppData\\Roaming\\interview-assistant-desktop'],
  ]);
  assert.equal(calls.lock, 1);
});

const Module = require('node:module');
const BOOTSTRAP_PATH = require.resolve('./bootstrap');

// Execute the real Electron entry with a faked electron module and stubbed
// side-effect modules, so ordering/loser guarantees cover bootstrap.js itself.
function loadRealBootstrap({
  app,
  loadMain = () => {},
  createConsoleRedactor = () => ({ uninstall() {} }),
  installFatalHandlers = () => {},
}) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return { app };
    if (parent && parent.filename === BOOTSTRAP_PATH) {
      if (request === './main') return loadMain();
      if (request === './log-redact') return { createConsoleRedactor };
      if (request === './fatal-log') return { installFatalHandlers };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    delete require.cache[BOOTSTRAP_PATH];
    require(BOOTSTRAP_PATH);
  } finally {
    Module._load = originalLoad;
    delete require.cache[BOOTSTRAP_PATH];
  }
}

test('real bootstrap.js takes the lock first and losers touch nothing else', () => {
  const order = [];
  const sideEffects = [];
  const app = {
    requestSingleInstanceLock() {
      order.push('lock');
      return false;
    },
    getPath() {
      order.push('getPath');
      return 'C:\\fake\\user-data';
    },
    setPath() {
      order.push('setPath');
    },
    on() {
      order.push('on');
    },
    quit() {
      order.push('quit');
    },
  };

  loadRealBootstrap({
    app,
    loadMain: () => sideEffects.push('main'),
    createConsoleRedactor: () => {
      sideEffects.push('redact');
      return { uninstall() {} };
    },
    installFatalHandlers: () => sideEffects.push('fatal'),
  });

  assert.deepEqual(order, ['lock', 'quit'], 'lock loser must quit without paths/listeners');
  assert.deepEqual(sideEffects, [], 'lock loser must not touch logging or main');
});

test('real bootstrap.js freezes userData then installs fatal logging before main', () => {
  const order = [];
  const setPathCalls = [];
  const fatalPaths = [];
  const app = {
    requestSingleInstanceLock() {
      order.push('lock');
      return true;
    },
    getPath() {
      order.push('getPath');
      return 'C:\\fake\\user-data';
    },
    setPath(name, value) {
      order.push('setPath');
      setPathCalls.push([name, value]);
    },
    on() {
      order.push('on');
    },
    quit() {},
  };

  loadRealBootstrap({
    app,
    loadMain: () => order.push('main'),
    createConsoleRedactor: () => {
      order.push('redact');
      return { uninstall() {} };
    },
    installFatalHandlers: ({ userDataPath }) => {
      order.push('fatal');
      fatalPaths.push(userDataPath);
    },
  });

  assert.deepEqual(order, ['lock', 'getPath', 'setPath', 'on', 'redact', 'fatal', 'main']);
  assert.deepEqual(setPathCalls, [['userData', 'C:\\fake\\user-data']]);
  assert.deepEqual(fatalPaths, ['C:\\fake\\user-data']);
});
