'use strict';

// 悬浮窗鼠标穿透的集中封装：native 调用失败必须让状态与真实窗口一致。
// 只有 overlay 窗口会收到 setIgnoreMouseEvents，主窗口永不穿透。
function createOverlayPassthroughController({
  getOverlayWindow,
  isOverlayVisible,
  isRecoveryShortcutOwned,
  onChange,
  onUnavailable,
}) {
  let enabled = false;

  function setEnabled(nextEnabled) {
    const win = getOverlayWindow();
    if (!win || win.isDestroyed()) {
      const wasEnabled = enabled;
      enabled = false;
      if (wasEnabled) onChange(false);
      return { ok: !nextEnabled, enabled: false };
    }

    if (nextEnabled) {
      if (win._overlayInputFaulted || !win._overlayReady || !isOverlayVisible() || !isRecoveryShortcutOwned()) {
        return { ok: false, enabled };
      }
      if (enabled) return { ok: true, enabled: true };
      try {
        win.setIgnoreMouseEvents(true, { forward: true });
      } catch {
        // 开启未确认成功时尽力回到已知的非穿透状态，且绝不发布 true。
        try { win.setIgnoreMouseEvents(false); } catch { /* 无 native 成功可确认 */ }
        return { ok: false, enabled: false };
      }
      enabled = true;
      onChange(true);
      return { ok: true, enabled: true };
    }

    if (!enabled) return { ok: true, enabled: false };
    try {
      win.setIgnoreMouseEvents(false);
      enabled = false;
      onChange(false);
      return { ok: true, enabled: false };
    } catch {
      win._overlayInputFaulted = true;
      let destroyed = false;
      try {
        win.destroy();
        destroyed = true;
      } catch {
        // 销毁也失败：保持穿透与恢复键，窗口标记为不可复用，禁止再次 show。
      }
      if (destroyed) {
        enabled = false;
        onChange(false);
      }
      onUnavailable('悬浮窗鼠标恢复失败，已关闭悬浮窗；可再次打开以恢复交互。');
      return { ok: false, enabled, destroyed };
    }
  }

  return {
    isEnabled: () => enabled,
    restoreBeforeReveal: () => (enabled ? setEnabled(false) : { ok: true, enabled: false }),
    setEnabled,
  };
}

// 快捷键 → overlay 的命令出口。作用域检查集中在这里，保证隐藏时全部 no-op。
function createOverlayCommandSender({ getOverlayWindow, isOverlayVisible, isFocusOverlayActive }) {
  function send(channel, payload) {
    const win = getOverlayWindow();
    if (!win || win.isDestroyed()) return false;
    win.webContents.send(channel, payload);
    return true;
  }

  return {
    sendFocusTab(direction) {
      if (!isFocusOverlayActive()) return false;
      return send('focus-tab-command', direction);
    },
    sendQuestion(direction) {
      if (!isOverlayVisible()) return false;
      return send('overlay-question-command', direction);
    },
    sendScroll(target, direction) {
      if (!isOverlayVisible()) return false;
      if (direction !== 'up' && direction !== 'down') return false;
      if (target !== 'answer' && target !== 'question') return false;
      if (target === 'question' && !isFocusOverlayActive()) return false;
      return send('overlay-scroll-command', { target, direction });
    },
  };
}

module.exports = { createOverlayCommandSender, createOverlayPassthroughController };
