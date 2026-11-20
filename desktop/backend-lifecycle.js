'use strict';

const { randomUUID } = require('node:crypto');

const READY_PREFIX = 'IA_BACKEND_READY ';
const MANAGED_ENV = 'IA_MANAGED_BACKEND';

function buildManagedEnv(baseEnvironment = {}) {
  return { ...baseEnvironment, [MANAGED_ENV]: '1' };
}

function buildSpawnOptions({ env, cwd, windowsHide = true } = {}) {
  return {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildManagedEnv(env),
    windowsHide,
  };
}

function buildDevArgs({ startScript, port }) {
  return [startScript, '--mode', 'network', '--no-build', '--skip-dep-check', '--port', String(port)];
}

function parseLaunchMarker(line) {
  const match = /^IA_BACKEND_READY (\S+)$/.exec(String(line));
  return match ? { launchId: match[1] } : null;
}

function createBackendLifecycle({
  exitTimeoutMs = 20000,
  readyTimeoutMs = 40000,
  createLaunchId = randomUUID,
} = {}) {
  let current = null;
  let unexpectedHandler = null;

  const failReady = (state, error) => {
    if (!state || !state.rejectReady) return;
    clearTimeout(state.readyTimer);
    state.rejectReady(error);
    state.rejectReady = null;
    state.resolveReady = null;
  };

  function attach(child, { launchId = createLaunchId() } = {}) {
    failReady(current, new Error('backend launch superseded'));
    const state = { child, launchId, ready: false, exited: false, closing: false, stopPromise: null };
    state.readyPromise = new Promise((resolve, reject) => {
      state.resolveReady = resolve;
      state.rejectReady = reject;
    });
    state.readyPromise.catch(() => {});
    state.readyTimer = setTimeout(() => {
      failReady(state, new Error('backend start timeout'));
    }, readyTimeoutMs);
    current = state;

    child.once('error', (error) => failReady(state, error));
    child.stdin?.on('error', () => {});
    child.once('exit', (code, signal) => {
      state.exited = true;
      state.exitCode = code;
      state.signalCode = signal;
      if (!state.ready) failReady(state, new Error('backend exited before it was ready'));
    });
    child.once('close', (code, signal) => {
      state.exited = true;
      clearTimeout(state.readyTimer);
      if (current !== state) return;
      current = null;
      if (!state.ready) {
        failReady(state, new Error('backend exited before it was ready'));
      } else if (!state.closing && unexpectedHandler) {
        unexpectedHandler({ code, signal, child });
      }
    });
    return child;
  }

  function acceptMarker(child, line) {
    const state = current;
    const parsed = parseLaunchMarker(line);
    if (!state || !parsed || child !== state.child || state.exited || state.closing) return false;
    if (child.exitCode != null || child.signalCode != null) return false;
    if (state.launchId !== parsed.launchId || state.ready || !state.resolveReady) return false;
    state.ready = true;
    clearTimeout(state.readyTimer);
    state.resolveReady(parsed.launchId);
    state.resolveReady = null;
    state.rejectReady = null;
    return true;
  }

  function shutdown() {
    const state = current;
    if (!state) return Promise.resolve();
    if (state.stopPromise) return state.stopPromise;
    state.closing = true;
    failReady(state, new Error('backend shutdown requested'));
    const child = state.child;
    if (state.exited || state.exitCode != null || state.signalCode != null
        || child.exitCode != null || child.signalCode != null) {
      if (current === state) current = null;
      return Promise.resolve();
    }
    state.stopPromise = new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off('exit', finish);
        child.off('close', finish);
        if (current === state) current = null;
        resolve();
      };
      child.once('exit', finish);
      child.once('close', finish);
      // EOF 请求后端跑完 lifespan。超时仅终止捕获的 child，仍等真实 exit/close。
      timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* child 可能刚退出 */ }
      }, exitTimeoutMs);
      try { child.stdin?.end(); } catch { /* stdin 失效则等待超时兜底 */ }
    });
    return state.stopPromise;
  }

  return {
    attach,
    acceptMarker,
    newLaunchId: () => createLaunchId(),
    buildDevArgs,
    buildManagedEnv,
    buildSpawnOptions,
    getChild: () => current?.child || null,
    getLaunchId: () => current?.launchId || null,
    isReady: () => Boolean(current?.ready),
    waitForReady: () => current?.readyPromise || Promise.reject(new Error('no backend child')),
    failReady: (error) => failReady(current, error),
    onUnexpectedExit: (handler) => { unexpectedHandler = handler; },
    beginShutdown: () => { if (current) current.closing = true; },
    shutdown,
    forceStop() {
      const state = current;
      if (!state) return;
      state.closing = true;
      failReady(state, new Error('backend shutdown requested'));
      const child = state.child;
      const alreadyGone = state.exited || state.exitCode != null || state.signalCode != null
        || child.exitCode != null || child.signalCode != null;
      if (!alreadyGone) {
        try { child.kill('SIGKILL'); } catch { /* child 可能刚退出 */ }
      }
      // kill() 发出信号不等于进程已退出；只有已确认退出才丢弃引用，
      // 否则仍由 close 事件负责收尾，避免谎报“已停止”。
      if (alreadyGone) current = null;
    },
  };
}

module.exports = { MANAGED_ENV, READY_PREFIX, createBackendLifecycle, parseLaunchMarker };
