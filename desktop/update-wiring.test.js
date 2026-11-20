'use strict';

// A1 接线回归（纯文本，不 require electron）：
//  - 内置 electron-updater 只在打包态使用；未打包退回 GitHub API 校验路径
//  - 只使用 check/download；绝不调用 quitAndInstall 或任何自动安装入口
//  - SDK logger 与 console 共用 bootstrap 的脱敏出口
//  - 安装仍走 launchInstaller（/S --updated --force-run），isQuitting 同步置位
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const TRANSPORT_SOURCE = fs.readFileSync(path.join(__dirname, 'update-transport.js'), 'utf8');
const BOOTSTRAP_SOURCE = fs.readFileSync(path.join(__dirname, 'bootstrap.js'), 'utf8');

function extractBracedBody(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `未找到 ${marker}`);
  const open = source.indexOf('{', start);
  assert.ok(open !== -1, `${marker} 缺少函数体`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`${marker} 函数体括号不匹配`);
}

function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the SDK updater is only enabled in a packaged app', () => {
  const body = extractBracedBody(MAIN_SOURCE, 'function buildUpdateController() {');
  assert.match(body, /app\.isPackaged/, 'must not hand autoUpdater to a dev run that cannot read app-update.yml');
  assert.match(body, /require\('electron-updater'\)/, 'packaged builds must use the pinned SDK transport');
  assert.match(body, /sdkUpdater,/, 'the resolved updater must reach the controller');
});

test('A1 never installs through the SDK', () => {
  const code = stripComments(MAIN_SOURCE) + stripComments(TRANSPORT_SOURCE);
  assert.ok(!/quitAndInstall/.test(code), 'installing stays on launchInstaller; quitAndInstall would bypass the NSIS flags');
  assert.ok(!/autoInstallOnAppQuit\s*=\s*true/.test(code));
  const transport = stripComments(TRANSPORT_SOURCE);
  assert.match(transport, /autoDownload\s*=\s*false/);
  assert.match(transport, /autoInstallOnAppQuit\s*=\s*false/);
  assert.match(transport, /disableWebInstaller\s*=\s*true/);
});

test('the SDK logger cannot bypass console redaction', () => {
  assert.match(BOOTSTRAP_SOURCE, /createConsoleRedactor\(\{\s*target:\s*console\s*\}\)/, 'bootstrap must redact console before main loads');
  assert.match(TRANSPORT_SOURCE, /updater\.logger\s*=\s*logger/, 'SDK output must go through the shared logger');
});

test('install still uses the silent NSIS flags and a synchronous isQuitting', () => {
  const body = extractBracedBody(MAIN_SOURCE, 'controller.onApplyAndQuit(');
  const flagIndex = body.indexOf('isQuitting = true');
  const stopIndex = body.indexOf('gracefulStopPython(');
  assert.ok(flagIndex !== -1 && stopIndex !== -1 && flagIndex < stopIndex);
});

test('the legacy fallback is never allowed to become size-only', () => {
  assert.match(TRANSPORT_SOURCE, /更新缺少可信摘要/, 'legacy downloads without an external digest must be refused');
  assert.match(TRANSPORT_SOURCE, /verifyFile\(downloadedPath, target\.integrity\)/, 'every download is verified');
});
