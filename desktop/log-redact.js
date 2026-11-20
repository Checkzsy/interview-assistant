'use strict';

const util = require('node:util');

// 只在日志出口脱敏已知凭据形态（与 backend/core/redact.py 同一口径）：
// Authorization Bearer/Basic、X-Api-Key/X-Api-Access-Key、URL query token、
// JSON/键值凭据、URL userinfo。不承诺识别任意无标签字符串。
const REDACTED = '***';
const CREDENTIAL_KEY =
  '(?:access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|' +
  'api[_-]?key|apikey|password|passwd|secret|token)';

const REDACTION_PATTERNS = [
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@?#]+@/gi, `$1${REDACTED}@`],
  [
    /\b(authorization["']?\s*[:=]\s*["']?\s*(?:bearer|basic|token|digest)\s+)[^\s"',;}\]&]+/gi,
    `$1${REDACTED}`,
  ],
  [/\b(x-api(?:-access)?-key["']?\s*[:=]\s*["']?)[^\s"',;}\]&]+/gi, `$1${REDACTED}`],
  [/([?&](?:access_token|refresh_token|api_key|apikey|token)=)[^&\s"'#<>]+/gi, `$1${REDACTED}`],
  [
    new RegExp(`(?<![\\w-])(${CREDENTIAL_KEY})(["']\\s*[:=]\\s*["'])((?:\\\\.|[^"\\\\\\n])*?)(["'])`, 'gi'),
    `$1$2${REDACTED}$4`,
  ],
  [
    new RegExp(`(?<![\\w-])(${CREDENTIAL_KEY})(\\\\?'\\s*[:=]\\s*\\\\?')((?:\\\\.|[^'\\\\\\n])*?)(\\\\?')`, 'gi'),
    `$1$2${REDACTED}$4`,
  ],
  [
    new RegExp(`(?<![\\w-])(${CREDENTIAL_KEY})(["']?\\s*[:=]\\s*)(["'])((?:\\\\.|(?!\\3)[^\\\\\\n])*?)\\3`, 'gi'),
    `$1$2$3${REDACTED}$3`,
  ],
  [new RegExp(`\\b(${CREDENTIAL_KEY})(["']?\\s*[:=]\\s*)([^\\s"',;}\\]&]+)`, 'gi'), `$1$2${REDACTED}`],
];

const FORMAT_FAILED = '[log formatting failed; message dropped]';
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'];

function redactText(value) {
  if (typeof value !== 'string') return value;
  let result = value;
  for (const [pattern, replacement] of REDACTION_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// 与 console 一致的格式化语义（%s/%d/%o 与 Error.stack 都包含在 util.format 结果里），
// 再对完整字符串脱敏。格式化或写入失败都只输出固定文本，绝不回退原始对象/栈。
function formatArgs(args) {
  try {
    return util.format(...args);
  } catch {
    return FORMAT_FAILED;
  }
}

function writeSafely(write, text) {
  try {
    write(text);
  } catch {
    /* 出口已失效：已脱敏的内容也写不出去，吞掉即可，不回退原始参数 */
  }
}

function createConsoleRedactor({ target = console } = {}) {
  const originals = new Map();
  for (const method of CONSOLE_METHODS) {
    if (typeof target[method] !== 'function') continue;
    originals.set(method, target[method].bind(target));
    target[method] = (...args) => {
      writeSafely(originals.get(method), redactText(formatArgs(args)));
    };
  }

  return {
    uninstall() {
      for (const [method, original] of originals) {
        target[method] = original;
      }
      originals.clear();
    },
  };
}

// SDK / 子模块共用出口：只接收已格式化文本，写盘前统一脱敏。
function createRedactingLogger({ sink = console.log } = {}) {
  const emit = (level, args) => {
    writeSafely((text) => sink(level, text), redactText(formatArgs(args)));
  };
  return {
    info: (...args) => emit('info', args),
    warn: (...args) => emit('warn', args),
    error: (...args) => emit('error', args),
    debug: (...args) => emit('debug', args),
  };
}

module.exports = {
  FORMAT_FAILED,
  createConsoleRedactor,
  createRedactingLogger,
  redactText,
};
