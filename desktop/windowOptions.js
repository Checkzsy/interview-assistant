const { StringDecoder } = require('node:string_decoder');
const { redactText } = require('./log-redact');

function createOverlayChromeOptions(platform, preferredResizable) {
  const isWindows = platform === 'win32';

  return {
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    // Windows transparent frameless windows can expose the native thick frame as
    // a white title strip. Removing it also removes native edge resizing there.
    resizable: isWindows ? false : Boolean(preferredResizable),
    ...(isWindows ? { thickFrame: false } : {}),
  };
}

const PROMPT_OVERLAY_DEFAULT_WIDTH = 820;
const PROMPT_OVERLAY_MAX_WIDTH = 820;

function getPromptOverlayInitialWidth(promptMaxWidth, fallbackWidth = PROMPT_OVERLAY_DEFAULT_WIDTH) {
  const value = Number(promptMaxWidth);
  const fallback = Number(fallbackWidth);
  const effective = Number.isFinite(value) && value > 0 ? value : fallback;
  return Math.max(180, Math.min(PROMPT_OVERLAY_MAX_WIDTH, Math.round(effective)));
}

function consumePendingOverlayShow(win, visible) {
  if (!win) return false;
  const shouldShow = Boolean(win._pendingShow && visible);
  win._pendingShow = false;
  return shouldShow;
}

function writeToStreamSafely(stream, chunk) {
  if (!stream || typeof stream.write !== 'function') return false;
  if (stream.destroyed || stream.writable === false) return false;
  try {
    stream.write(chunk);
    return true;
  } catch {
    return false;
  }
}

const RELAY_MAX_LINE_BYTES = 8 * 1024;
const RELAY_DROPPED_TEXT = '[oversized output line dropped]\n';

function relayChildOutput(childStream, targetStream, prefix = '', { onLine } = {}) {
  if (!childStream || typeof childStream.on !== 'function') return () => {};

  // 每流独立：StringDecoder 处理跨 chunk 的 UTF-8，完整行缓冲保证凭据不会被 chunk 切断。
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let dropping = false;

  const emitLine = (line) => {
    writeToStreamSafely(targetStream, `${prefix}${redactText(line)}\n`);
    if (typeof onLine === 'function') {
      try {
        onLine(line);
      } catch {
        /* 行解析失败不能影响日志转发 */
      }
    }
  };

  const feed = (text) => {
    if (!text) return;
    if (dropping) {
      const newline = text.indexOf('\n');
      if (newline === -1) return;
      dropping = false;
      feed(text.slice(newline + 1));
      return;
    }

    pending += text;
    let newline = pending.indexOf('\n');
    while (newline !== -1) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      if (Buffer.byteLength(line, 'utf8') > RELAY_MAX_LINE_BYTES) {
        writeToStreamSafely(targetStream, `${prefix}${RELAY_DROPPED_TEXT}`);
      } else {
        emitLine(line);
      }
      newline = pending.indexOf('\n');
    }
    if (Buffer.byteLength(pending, 'utf8') > RELAY_MAX_LINE_BYTES) {
      pending = '';
      dropping = true;
      writeToStreamSafely(targetStream, `${prefix}${RELAY_DROPPED_TEXT}`);
    }
  };

  const onData = (chunk) => {
    feed(typeof chunk === 'string' ? decoder.write(Buffer.from(chunk, 'utf8')) : decoder.write(chunk));
  };
  childStream.on('data', onData);
  return () => {
    if (typeof childStream.off === 'function') childStream.off('data', onData);
    else if (typeof childStream.removeListener === 'function') childStream.removeListener('data', onData);
  };
}

module.exports = {
  PROMPT_OVERLAY_DEFAULT_WIDTH,
  PROMPT_OVERLAY_MAX_WIDTH,
  consumePendingOverlayShow,
  createOverlayChromeOptions,
  getPromptOverlayInitialWidth,
  relayChildOutput,
  writeToStreamSafely,
};
