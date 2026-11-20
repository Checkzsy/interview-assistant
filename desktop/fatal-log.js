'use strict';

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const { redactText } = require('./log-redact');

const MAX_LOG_BYTES = 512 * 1024;
const LOG_DIR_NAME = 'logs';
const LOG_FILE_NAME = 'main-crash.log';
const WRITE_FAILED = '[fatal log write failed]\n';
const FORMAT_FAILED = '[fatal log formatting failed]\n';

// 先格式化（含 Error.stack），再脱敏，最后按 UTF-8 字节截断。
// 顺序不能换：截断放在脱敏前可能把凭据切成无法识别的半截。
function formatFatal(value) {
  let text;
  try {
    if (value instanceof Error) {
      text = value.stack || `${value.name}: ${value.message}`;
    } else {
      text = util.inspect(value, { depth: 4, breakLength: Infinity });
    }
  } catch {
    text = FORMAT_FAILED;
  }
  return redactText(typeof text === 'string' ? text : FORMAT_FAILED);
}

function buildCrashEntry({ kind, error, now = new Date() }) {
  const stamp = now instanceof Date && !Number.isNaN(now.valueOf())
    ? now.toISOString()
    : new Date().toISOString();
  return `[${stamp}] ${kind}\n${formatFatal(error)}\n\n`;
}

function cutUtf8(text, maxBytes) {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  // 退到 UTF-8 起始字节，避免把多字节字符切成残缺字节。
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}

function writeCrashLog({ userDataPath, text }) {
  const logDir = path.join(userDataPath, LOG_DIR_NAME);
  const logPath = path.join(logDir, LOG_FILE_NAME);
  const bounded = cutUtf8(redactText(String(text)), MAX_LOG_BYTES);
  let written = false;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    let existing = '';
    try {
      existing = fs.readFileSync(logPath, 'utf8');
    } catch {
      existing = '';
    }
    // 上限 + 1 份备份：写不下时把当前日志整份挪到 .1，新条目单独落盘。
    if (Buffer.byteLength(existing, 'utf8') + Buffer.byteLength(bounded, 'utf8') > MAX_LOG_BYTES) {
      if (existing) {
        fs.writeFileSync(`${logPath}.1`, cutUtf8(existing, MAX_LOG_BYTES), { encoding: 'utf8' });
      }
      fs.writeFileSync(logPath, bounded, { encoding: 'utf8' });
    } else {
      fs.writeFileSync(logPath, existing + bounded, { encoding: 'utf8' });
    }
    written = true;
  } catch {
    written = false;
  }
  return { written, logPath };
}

// 安装后由本模块独占 uncaughtException / unhandledRejection：
// 同步写完有界崩溃日志，再非零退出。不吞异常继续运行，也不等异步后端收尾。
function installFatalHandlers({ userDataPath, app, onExit } = {}) {
  let handling = false;

  const handle = (kind) => (error) => {
    if (handling) return;
    handling = true;
    const entry = buildCrashEntry({ kind, error });
    let written = false;
    try {
      written = writeCrashLog({ userDataPath, text: entry }).written;
    } catch {
      /* 路径/格式化失败也不得回退原始内容。 */
    }
    if (!written) {
      try {
        process.stderr.write(WRITE_FAILED);
      } catch {
        /* stderr 也不可用时仍需非零退出 */
      }
    }
    try {
      if (typeof onExit === 'function') onExit();
    } catch {
      /* 退出钩子失败不阻止退出 */
    }
    process.exitCode = 1;
    if (app && typeof app.exit === 'function') {
      try { app.exit(1); } catch { process.exit(1); }
    }
  };

  const onUncaught = handle('uncaughtException');
  const onRejection = handle('unhandledRejection');
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onRejection);

  return {
    uninstall() {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onRejection);
    },
  };
}

module.exports = {
  MAX_LOG_BYTES,
  buildCrashEntry,
  cutUtf8,
  installFatalHandlers,
  writeCrashLog,
};
