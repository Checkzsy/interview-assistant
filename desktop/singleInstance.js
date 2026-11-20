'use strict';

// 单实例门卫与首帧揭示闸门。
// 这里只做两件可单测的事：谁可以加载主进程、主窗何时允许被「显示」请求触碰。
// Electron 入口本身在 bootstrap.js，本文件不 require electron。

function createRevealGate() {
  let open = false;
  let pendingReveal = null;

  return {
    // 闸门关闭期间只记下请求（覆盖重复请求），不碰任何窗口对象。
    reveal(doReveal) {
      if (!open) {
        pendingReveal = doReveal;
        return false;
      }
      doReveal();
      return true;
    },
    open() {
      open = true;
    },
    // 首帧安全后调用一次：把期间暂存的请求补执行一次。
    requestPending() {
      if (!pendingReveal) return false;
      const doReveal = pendingReveal;
      pendingReveal = null;
      doReveal();
      return true;
    },
    isOpen() {
      return open;
    },
  };
}

let revealTarget = null;

// 主进程加载后注册真正的 revealMainWindow，避免 bootstrap 反向依赖 main.js。
function setRevealTarget(fn) {
  revealTarget = typeof fn === 'function' ? fn : null;
}

const bootstrapGate = createRevealGate();

function installBootstrap({
  app,
  loadMain,
  installFatal,
  userDataPath,
  setPath,
  gate = bootstrapGate,
}) {
  if (app.__iaMainLoaded) return { primary: true, gate };
  if (!app.requestSingleInstanceLock()) {
    // 锁失败者：零主进程副作用，直接退出。
    app.quit();
    return { primary: false };
  }

  const frozenPath = typeof userDataPath === 'function' ? userDataPath() : userDataPath;
  if (typeof setPath === 'function' && frozenPath) setPath('userData', frozenPath);

  app.on('second-instance', () => {
    gate.reveal(() => {
      if (revealTarget) revealTarget();
    });
  });
  if (typeof installFatal === 'function') installFatal(frozenPath);

  app.__iaMainLoaded = true;
  loadMain();

  return { primary: true, gate };
}

module.exports = {
  bootstrapGate,
  createRevealGate,
  installBootstrap,
  setRevealTarget,
};
