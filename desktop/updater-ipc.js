const path = require('node:path');
const fs = require('node:fs');
const { checkForUpdate, downloadFile, launchInstaller } = require('./updater');

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
    },
    installing: false,
    installError: null,
  };

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
      installing: state.installing,
      installError: state.installError,
    };
  }

  async function check() {
    if (state.checking) return serialize();
    state.checking = true;
    state.checkError = null;
    emit();
    try {
      const result = await checkForUpdate({
        currentVersion: state.current,
        kind: 'exe',
        apiUrl,
        request,
      });
      state.latest = result.latest;
      state.hasUpdate = result.hasUpdate;
      state.asset = result.asset;
      state.releaseName = result.releaseName;
      state.publishedAt = result.publishedAt;
    } catch (error) {
      state.checkError = error && error.message ? error.message : String(error);
      // 检查失败保持上次状态，绝不抛出或中断应用。
    } finally {
      state.checking = false;
      emit();
    }
    return serialize();
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
    const asset = state.asset;
    if (!asset || !asset.url) {
      state.download = { status: 'error', received: 0, total: 0, error: '没有可下载的更新文件', downloadedPath: null };
      emit();
      return serialize();
    }
    if (state.download.status === 'downloading') return serialize();
    fs.mkdirSync(downloadsDir, { recursive: true });
    const destPath = path.join(downloadsDir, asset.name);
    state.download = { status: 'downloading', received: 0, total: asset.size || 0, error: null, downloadedPath: null };
    emit();
    try {
      const result = await downloadFn(asset.url, destPath, {
        onProgress: ({ received, total }) => {
          state.download = { ...state.download, status: 'downloading', received, total: total || asset.size || 0 };
          emit();
        },
        expectedBytes: asset.size,
        timeoutMs,
      });
      state.download = { status: 'done', received: result.received, total: result.total || asset.size || 0, error: null, downloadedPath: destPath };
    } catch (error) {
      state.download = { status: 'error', received: 0, total: 0, error: error && error.message ? error.message : String(error), downloadedPath: null };
    }
    emit();
    return serialize();
  }

  async function install() {
    const filePath = state.download.downloadedPath;
    if (state.download.status !== 'done' || !filePath || !fs.existsSync(filePath)) {
      state.installError = '安装包尚未就绪';
      emit();
      return { ok: false, error: state.installError };
    }
    if (state.installing) return { ok: false, error: '正在安装中' };
    state.installing = true;
    state.installError = null;
    emit();
    const result = await launchFn(filePath);
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
