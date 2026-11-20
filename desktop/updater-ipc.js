const fs = require('node:fs');
const { downloadFile, launchInstaller } = require('./updater');
const { createElectronUpdateTransport, verifyFile } = require('./update-transport');

/**
 * 更新控制器：把 updater 纯逻辑与 Electron 主进程/渲染进程桥接起来。
 * 全部通过注入的 send(event, payload) 推送状态，主进程只负责把 channel 透传给 BrowserWindow。
 * 独立成模块以便在 node --test 下用假 send 单测，不触碰 main.js 原有逻辑。
 */
function createUpdateController({
  currentVersion,
  downloadsDir,
  apiUrl,
  checkDelayMs = 0,
  timeoutMs = 30000,
  request,
  sdkUpdater,
  createTransport = createElectronUpdateTransport,
  downloadFn = downloadFile,
  launchFn = launchInstaller,
}) {
  const state = {
    current: currentVersion ?? null,
    latest: null,
    hasUpdate: false,
    asset: null,
    releaseName: null,
    publishedAt: null,
    checking: false,
    checkError: null,
    download: {
      status: 'idle', // idle | downloading | done | error
      received: 0,
      total: 0,
      error: null,
      downloadedPath: null,
      targetVersion: null,
      targetId: null,
    },
    install: {
      blocked: false,
      reason: null,
    },
    installing: false,
    installError: null,
  };

  let transport = null;
  let target = null;
  let pendingCheck = false;
  let checkTimer = null;

  function emit() {
    if (typeof emitFn === 'function') emitFn('updater:state', state);
  }
  let emitFn = null;
  function onEmit(fn) {
    emitFn = fn;
  }

  function serialize() {
    return {
      current: state.current,
      latest: state.latest,
      hasUpdate: state.hasUpdate,
      asset: state.asset ? { ...state.asset } : null,
      releaseName: state.releaseName,
      publishedAt: state.publishedAt,
      checking: state.checking,
      checkError: state.checkError,
      download: { ...state.download },
      install: { ...state.install },
      installing: state.installing,
      installError: state.installError,
    };
  }

  function getTransport() {
    if (!transport) {
      transport = createTransport({
        currentVersion: state.current,
        downloadsDir,
        apiUrl,
        request,
        downloadFn,
        updater: sdkUpdater,
        logger: console,
      });
    }
    return transport;
  }

  function isBusy() {
    return state.download.status === 'downloading' || state.installing;
  }

  async function runCheck() {
    state.checking = true;
    state.checkError = null;
    emit();
    try {
      const result = await getTransport().check();
      state.latest = result.latest;
      state.hasUpdate = result.hasUpdate;
      state.asset = result.asset;
      state.releaseName = result.releaseName;
      state.publishedAt = result.publishedAt;
      // 新检查重新确立当前目标：上一次安装失败的提示不能继续遮蔽本次结果。
      state.installError = null;
      target = result.hasUpdate ? result : null;
      if (!result.hasUpdate) {
        state.download = idleDownload();
        state.install = { blocked: false, reason: null };
      } else if (state.download.targetId && state.download.targetId !== result.targetId) {
        // 检查发现另一个目标：旧包已不代表当前版本，禁止安装并要求重新下载。
        state.download = { ...idleDownload(), targetVersion: result.latest, targetId: result.targetId };
        state.install = { blocked: false, reason: null };
      } else {
        // 同一目标：已完成的包继续有效，仅补上目标标记。
        state.download = { ...state.download, targetVersion: result.latest, targetId: result.targetId };
        state.install = { blocked: false, reason: null };
      }
    } catch (error) {
      state.checkError = error && error.message ? error.message : String(error);
      // 检查失败保持上次状态，绝不抛出或中断应用。
    } finally {
      state.checking = false;
      emit();
    }
    return serialize();
  }

  function idleDownload(status = 'idle', error = null) {
    return {
      status, received: 0, total: 0, error, downloadedPath: null,
      targetVersion: state.latest, targetId: target ? target.targetId : null,
    };
  }

  async function flushPendingCheck() {
    if (!pendingCheck) return;
    pendingCheck = false;
    await runCheck();
  }

  async function check() {
    // SDK 的 updateInfo 是可变状态：下载/安装进行中绝不再发起检查，合并成一次待执行请求。
    if (state.checking) return serialize();
    if (isBusy()) {
      pendingCheck = true;
      return serialize();
    }
    return runCheck();
  }

  function scheduleCheck(delayMs) {
    if (checkTimer) clearTimeout(checkTimer);
    checkTimer = setTimeout(() => {
      checkTimer = null;
      check().catch(() => {});
    }, delayMs);
    return checkTimer;
  }

  async function download() {
    if (state.download.status === 'downloading' || state.installing) return serialize();
    if (!target || !target.hasUpdate) {
      state.download = {
        status: 'error', received: 0, total: 0, error: '没有可下载的更新文件', downloadedPath: null,
        targetVersion: state.download.targetVersion, targetId: state.download.targetId,
      };
      emit();
      return serialize();
    }
    if (state.download.status === 'done' && state.download.targetId === target.targetId) return serialize();
    const targetVersion = target.latest;
    state.download = {
      status: 'downloading', received: 0, total: target.asset?.size || 0, error: null, downloadedPath: null,
      targetVersion, targetId: target.targetId,
    };
    state.install = { blocked: false, reason: null };
    // 重新下载即开始新的尝试，旧安装失败提示随旧包作废。
    state.installError = null;
    emit();
    try {
      const result = await getTransport().download(target, {
        onProgress: ({ received, total }) => {
          state.download = { ...state.download, status: 'downloading', received, total: total || target.asset?.size || 0 };
          emit();
        },
        timeoutMs,
      });
      state.download = {
        status: 'done', received: result.received, total: result.total || target.asset?.size || 0,
        error: null, downloadedPath: result.downloadedPath, targetVersion, targetId: target.targetId,
      };
    } catch (error) {
      state.download = {
        status: 'error', received: 0, total: 0, error: error && error.message ? error.message : String(error),
        downloadedPath: null, targetVersion, targetId: target.targetId,
      };
    }
    emit();
    await flushPendingCheck();
    return serialize();
  }

  async function install(options) {
    const { silent = true } = options || {};
    const filePath = state.download.downloadedPath;
    if (state.download.status !== 'done' || !filePath || !fs.existsSync(filePath)) {
      state.installError = '安装包尚未就绪';
      emit();
      return { ok: false, error: state.installError };
    }
    if (!target || state.download.targetId !== target.targetId || state.download.targetVersion !== target.latest) {
      state.install = { blocked: true, reason: '当前安装包不是已检查的版本' };
      state.installError = state.install.reason;
      state.download = idleDownload('error', state.installError);
      emit();
      return { ok: false, error: state.installError };
    }
    if (state.installing) return { ok: false, error: '正在安装中' };
    state.installing = true;
    state.installError = null;
    emit();
    try {
      // 下载期间文件可能被破坏或替换：安装前重新计算并比对冻结摘要。
      await verifyFile(filePath, target.integrity);
    } catch (error) {
      state.installing = false;
      state.install = { blocked: true, reason: '安装包校验失败，请重新下载' };
      state.installError = state.install.reason;
      state.download = idleDownload('error', state.installError);
      emit();
      return { ok: false, error: state.installError };
    }
    const result = await launchFn(filePath, { silent });
    if (!result.ok) {
      state.installing = false;
      state.installError = result.error || '启动安装器失败';
      emit();
      return { ok: false, error: state.installError };
    }
    // 安装器已 detached 启动：马上通知渲染进程，由主进程回调执行优雅退出。
    if (typeof onApplyAndQuitFn === 'function') onApplyAndQuitFn();
    return { ok: true };
  }
  let onApplyAndQuitFn = null;
  function onApplyAndQuit(fn) {
    onApplyAndQuitFn = fn;
  }

  function dispose() {
    if (checkTimer) { clearTimeout(checkTimer); checkTimer = null; }
  }

  return {
    serialize,
    check,
    scheduleCheck,
    download,
    install,
    onEmit,
    onApplyAndQuit,
    dispose,
  };
}

module.exports = { createUpdateController };
