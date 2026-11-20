'use strict';

// 生命周期接线回归（纯文本读取，不 require electron）：
//  - 端口全占用时安全退出，不返回假端口也不杀占用者
//  - 后端只认本次 spawn 的自有 child 与 launchId 标记
//  - 正常/更新退出先关 stdin 等真实退出，不再 POST /api/stop
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MAIN_SOURCE = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
const BOOTSTRAP_SOURCE = fs.readFileSync(path.join(__dirname, 'bootstrap.js'), 'utf8');

// 注释里提到旧实现不算保留：只对代码文本做断言。
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function extractBracedBody(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `未找到 ${marker}`);
  const open = source.indexOf('{', start);
  assert.ok(open !== -1, `${marker} 缺少函数体`);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`${marker} 函数体括号不匹配`);
}

test('all occupied candidate ports fails startup instead of guessing a free port', () => {
  const body = extractBracedBody(MAIN_SOURCE, 'app.whenReady().then(async () => {');
  const portIndex = body.indexOf('PORT = await resolveServerPort(');
  const nullCheck = body.indexOf('PORT === null');
  const startIndex = body.indexOf('startPythonBackend()');

  assert.ok(portIndex !== -1, '启动路径必须解析端口');
  assert.ok(nullCheck !== -1 && nullCheck > portIndex, '端口解析后必须显式处理 null');
  assert.ok(startIndex > nullCheck, 'null 端口不得继续启动后端');
  assert.match(body.slice(nullCheck, startIndex), /failStartup|return;/, 'null 端口应走失败退出');
});

test('readiness accepts only the captured child stdout marker, not /api/options', () => {
  const body = extractBracedBody(MAIN_SOURCE, 'function startPythonBackend() {');

  assert.match(body, /backend\.attach\(child, \{ launchId \}\)/, '必须捕获并绑定本次 child');
  assert.match(body, /onLine: \(line\) => \{ backend\.acceptMarker\(child, line\); \}/, '就绪只读自有 child 的 stdout');
  assert.match(body, /waitForReady\(\)/, '启动等待应使用标记就绪');
  const codeOnly = stripComments(body);
  assert.ok(!/waitForServer|api\/options/.test(codeOnly), '不能再以端口应答代替自有 child 就绪');
  assert.match(body, /buildSpawnOptions\(/, 'spawn 选项必须来自生命周期模块（stdin=pipe）');
});

test('stop path closes our stdin and waits for the real exit, never POSTs /api/stop', () => {
  const body = extractBracedBody(MAIN_SOURCE, 'function gracefulStopPython()');

  assert.match(body, /backend\.shutdown\(\)/, '正常退出必须走生命周期 shutdown');
  assert.ok(!/requestAssistStop|api\/stop/.test(stripComments(MAIN_SOURCE)), '不得再向端口 POST /api/stop');
});

test('will-quit only touches the captured child as a fallback', () => {
  const body = extractBracedBody(MAIN_SOURCE, "app.on('will-quit', () => {");

  assert.match(body, /backend\.forceStop\(\)/, '异常路径兜底只终止捕获的 child');
  assert.ok(!/taskkill|kill_port|netstat/.test(stripComments(MAIN_SOURCE)), '不得按名字/端口杀进程');
});

test('reveal restores a minimized window before showing it', () => {
  const start = MAIN_SOURCE.indexOf('function revealMainWindowNow(');
  const end = MAIN_SOURCE.indexOf('function revealMainWindow(', start);
  assert.ok(start !== -1 && end > start, 'reveal body boundaries missing');
  const body = stripComments(MAIN_SOURCE.slice(start, end));

  const restore = body.indexOf('mainWindow.isMinimized()');
  const show = body.indexOf('mainWindow.show()');
  assert.ok(restore !== -1, 'minimized windows need an explicit restore');
  assert.ok(show !== -1 && restore < show, 'restore must run before show');
  assert.match(body.slice(restore, show), /mainWindow\.restore\(\)/);
});

test('startup failure shows a fixed error box even before a main window exists', () => {
  const body = stripComments(extractBracedBody(MAIN_SOURCE, 'function failStartup(reason)'));

  assert.match(body, /dialog\.showErrorBox\(/, '启动失败必须给用户可见提示');
  assert.ok(!/if \(mainWindow/.test(body), '主窗尚未创建时也不能吞掉提示');
  assert.match(body, /后台服务没能正常启动/, '提示文案固定且可执行');
  const afterBox = body.slice(body.indexOf('dialog.showErrorBox'));
  assert.ok(!afterBox.includes('reason'), '原始错误只进日志，不拼进用户提示');
});

test('port, spawn and readiness failures all route through failStartup', () => {
  const whenReady = extractBracedBody(MAIN_SOURCE, 'app.whenReady().then(async () => {');

  assert.match(whenReady, /failStartup\('all candidate ports are occupied'\)/);
  assert.match(whenReady, /await startPythonBackend\(\)/);
  assert.match(whenReady, /failStartup\(err\?\.message \|\| String\(err\)\)/, '启动异常统一走失败路径');
});

test('bootstrap installs redaction and fatal logging before requiring main', () => {
  const redactIndex = BOOTSTRAP_SOURCE.indexOf('createConsoleRedactor({ target: console })');
  const bootstrapIndex = BOOTSTRAP_SOURCE.indexOf('installBootstrap({');
  const mainIndex = BOOTSTRAP_SOURCE.indexOf("loadMain: () => require('./main')");

  assert.ok(redactIndex !== -1 && bootstrapIndex !== -1 && mainIndex !== -1);
  assert.ok(redactIndex < mainIndex, '持锁后先安装 console 脱敏，再加载 main');
  // installFatal 早于 loadMain 的执行顺序由 singleInstance 单测保证（对象字面量顺序不可见）。
  assert.ok(bootstrapIndex < mainIndex, '主进程必须由 installBootstrap 统一加载');
  assert.ok(
    BOOTSTRAP_SOURCE.indexOf('requestSingleInstanceLock(') === -1,
    '锁请求应由 singleInstance 的可注入实现持有',
  );
});
